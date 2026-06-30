// src/tools/monitor.ts
import { z } from 'zod'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Tool } from './types.js'
import { TASKS_DIR } from '../config.js'
import { registerTask, updateTask, enqueueNotification, generateTaskId, killProcessTree } from '../tasks.js'

export const MONITOR = {
  batchMs: 200,
  bucketCapacity: 10,
  refillMs: 2000,
  overflowKillMs: 30_000,
  perLineCap: 500,
  defaultTimeoutMs: 300_000,
  maxTimeoutMs: 3_600_000,
} as const

/** 令牌桶：容量 capacity，每 refillMs 补 1。allow 抑制时累计 overflow 起点，持续超 overflowKillMs → shouldStop。 */
export class TokenBucket {
  private tokens: number = MONITOR.bucketCapacity
  private last: number
  private overflowSince: number | null = null
  constructor(startTs: number) { this.last = startTs }
  allow(now: number): boolean {
    const refill = Math.floor((now - this.last) / MONITOR.refillMs)
    if (refill > 0) { this.tokens = Math.min(MONITOR.bucketCapacity, this.tokens + refill); this.last = now }
    if (this.tokens > 0) {
      this.tokens--
      // Only clear overflow timer if tokens remain — a single refill consumed immediately means still flooded
      if (this.tokens > 0) this.overflowSince = null
      return true
    }
    if (this.overflowSince === null) this.overflowSince = now
    return false
  }
  shouldStop(now: number): boolean {
    return this.overflowSince !== null && (now - this.overflowSince) >= MONITOR.overflowKillMs
  }
}

const schema = z.object({
  command: z.string().describe('shell 命令/脚本。每行 stdout = 一个事件；退出结束监控'),
  description: z.string().describe('监控对象的简短描述（出现在通知里）'),
  timeout_ms: z.number().min(1000).default(MONITOR.defaultTimeoutMs).describe(`超时 kill（默认 ${MONITOR.defaultTimeoutMs}，max ${MONITOR.maxTimeoutMs}）。persistent 时忽略`),
  persistent: z.boolean().default(false).describe('会话生命周期内常驻（无超时）。用 TaskStop 停'),
})

export const monitorTool: Tool<typeof schema> = {
  name: 'Monitor',
  description:
    '启动后台监控，从长跑脚本流式取事件。每行 stdout 是一个事件——你继续干活，通知到达聊天。\n\n' +
    '200ms 内的多行合并为一条通知。脚本在与 Bash 相同的 shell 环境跑，退出结束监控（报退出码），超时被 kill。persistent:true 用于会话级监控（盯 PR/日志尾），靠 TaskStop 或会话结束停。\n\n' +
    '过滤要狠（grep --line-buffered）：产生过多事件的监控会被自动停止。',
  inputSchema: schema,
  isReadOnly: true,           // 不写文件；但 spawn shell——比照 bash 后台不需逐次审批
  needsPermission: () => false,
  async call(input, ctx) {
    if ((ctx as any).isSubagent) return 'Monitor 不可在子代理中启动。'
    const timeout = input.persistent ? undefined : Math.min(input.timeout_ms, MONITOR.maxTimeoutMs)
    const id = generateTaskId('local_bash')
    fs.mkdirSync(TASKS_DIR, { recursive: true })
    const outputFile = path.join(TASKS_DIR, `${id}.log`)
    const ws = fs.createWriteStream(outputFile)
    const child = spawn('bash', ['-c', input.command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    registerTask({ id, type: 'local_bash', kind: 'monitor', status: 'running', description: input.description, startTime: Date.now(), outputFile, outputOffset: 0, notified: false, command: input.command, child } as any)

    // Fix 2: drain stderr to prevent child stall at ~64KB buffer
    child.stderr?.resume()

    const bucket = new TokenBucket(Date.now())
    let buf = ''
    let suppressed = 0
    let stopped = false  // Fix 1: guard shouldStop branch against re-firing

    // Fix 4: 200ms line batching
    let pending: string[] = []
    let batchTimer: NodeJS.Timeout | null = null
    const flushBatch = (): void => {
      if (pending.length) {
        enqueueNotification({ id, type: 'local_bash', kind: 'monitor', status: 'running', description: pending.join('\n'), startTime: 0, outputFile, outputOffset: 0, notified: false } as any)
        pending = []
      }
      batchTimer = null
    }

    const emit = (line: string): void => {
      const now = Date.now()
      if (bucket.shouldStop(now)) {
        if (!stopped) {  // Fix 1: only kill+notify once
          stopped = true
          flushBatch()  // Fix 4: flush pending before stop notification
          updateTask(id, { status: 'killed' } as any)
          killProcessTree(child, 'SIGTERM')
          enqueueNotification({ id, type: 'local_bash', kind: 'monitor', status: 'killed', description: `[Monitor 已停——输出过多，${suppressed} 个事件被抑制。换更狠的过滤]`, startTime: 0, outputFile, outputOffset: 0, notified: false } as any)
        }
        return
      }
      if (!bucket.allow(now)) { suppressed++; return }
      const trimmed = line.slice(0, MONITOR.perLineCap)
      ws.write(line + '\n')
      // Fix 4: batch lines arriving within batchMs into one notification
      pending.push(`Monitor「${input.description}」: ${trimmed}`)
      if (batchTimer === null) {
        batchTimer = setTimeout(flushBatch, MONITOR.batchMs)
        batchTimer.unref?.()
      }
    }
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) emit(line) }
    })
    child.once('exit', (code, signal) => {  // Fix 3: capture signal for null-code display
      flushBatch()  // Fix 4: flush pending before exit notification
      ws.end()
      const exitStatus = code === 0 ? 'completed' : 'failed'
      updateTask(id, { status: exitStatus, endTime: Date.now() } as any)
      enqueueNotification({ id, type: 'local_bash', kind: 'monitor', status: exitStatus, description: `Monitor「${input.description}」结束（退出码 ${code ?? signal}）`, startTime: 0, outputFile, outputOffset: 0, notified: false } as any)
    })
    if (timeout !== undefined) setTimeout(() => { if (child.exitCode === null) killProcessTree(child, 'SIGTERM') }, timeout).unref?.()
    return `Monitor 已启动 id=${id}（${input.persistent ? '常驻' : `${timeout}ms 超时`}）。事件将作为 task-notification 到达。用 TaskStop ${id} 停止。`
  },
}
