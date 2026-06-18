// src/tools/bash.ts
import { z } from 'zod'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import type { Tool } from './types.js'
import { TASKS_DIR, taskOutputPath } from '../config.js'
import { registerTask, updateTask, getTask, enqueueNotification, generateTaskId } from '../tasks.js'
import { getSessionEnvScript, clearCwdEnvFiles, invalidateSessionEnvCache } from '../sessionEnv.js'

const MAX_OUTPUT = 30_000
const MARKER = '__DEEPCODE_END__'

const schema = z.object({
  command: z.string().describe('要执行的 bash 命令'),
  timeout: z.number().int().max(600_000).optional().describe('超时毫秒数，默认 120000'),
  run_in_background: z.boolean().optional().describe('设为 true 在后台运行；用 TaskOutput 读输出'),
})

export function truncateMiddle(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s
  const half = Math.floor(max / 2)
  return s.slice(0, half) + `\n…[输出过长，已截断中间 ${s.length - max} 字符]…\n` + s.slice(-half)
}

export const bashTool: Tool<typeof schema> = {
  name: 'Bash',
  description:
    '在持久化工作目录中执行 bash 命令（cd 会影响后续所有命令）。默认 120 秒超时。输出超过 30000 字符会截断中间部分。查找文件请用 Glob/Grep 而不是 find/grep 命令。',
  inputSchema: schema,
  isReadOnly: false,
  needsPermission: input => input.command,
  call(input, ctx) {
    const envPrefix = getSessionEnvScript(ctx.sessionId?.())
    const prefixed = (cmd: string) => (envPrefix ? `${envPrefix}\n${cmd}` : cmd)
    // 子代理保持纯执行：忽略 run_in_background，降级为前台同步执行（防污染主会话通知队列）。
    if (input.run_in_background === true && !ctx.isSubagent) {
      const id = generateTaskId('local_bash')
      const outputFile = taskOutputPath(id)
      fs.mkdirSync(TASKS_DIR, { recursive: true })
      const ws = fs.createWriteStream(outputFile)
      // detached:true → 子进程成进程组长，便于 kill 整组（杀 npm run dev 等 fork 的孙进程，修孤儿）
      const child = spawn('/bin/bash', ['-c', prefixed(input.command)], { cwd: ctx.cwd(), detached: true })
      // 两路都写同一文件：用 end:false，避免先结束的流提前关闭 ws 截断另一路；exit 时统一 ws.end()
      child.stdout.pipe(ws, { end: false })
      child.stderr.pipe(ws, { end: false })
      registerTask({
        id,
        type: 'local_bash',
        status: 'running',
        description: input.command,
        command: input.command,
        child,
        outputFile,
        outputOffset: 0,
        notified: false,
        startTime: Date.now(),
      })
      ctx.hookDispatch?.('TaskCreated', { hook_event_name: 'TaskCreated', task_kind: 'background', task_id: id, task_description: input.command }).catch(() => {})
      child.once('exit', code => {
        ws.end()
        // 若已被 TaskStop 置为 killed，保留之——SIGTERM 触发的本 exit 回调不该把 killed 覆写成 failed。
        const t = getTask(id)
        if (t && t.status === 'killed') {
          ctx.hookDispatch?.('TaskCompleted', { hook_event_name: 'TaskCompleted', task_kind: 'background', task_id: id, status: 'killed' }).catch(() => {})
          return
        }
        updateTask(id, { status: code === 0 ? 'completed' : 'failed', endTime: Date.now() })
        enqueueNotification(getTask(id)!)
        ctx.hookDispatch?.('TaskCompleted', { hook_event_name: 'TaskCompleted', task_kind: 'background', task_id: id, status: getTask(id)!.status }).catch(() => {})
      })
      return Promise.resolve(`后台任务已启动 id=${id}，输出写入 ${outputFile}。用 TaskList/TaskOutput/TaskStop 管理。`)
    }
    return new Promise(resolve => {
      // session-env 前缀（hook 写的 export 行）内联在用户命令前，使其 env 生效。
      // 已知局限（与 CC 内联前缀一致）：若 hook 脚本含 `set -e` 等会泄漏到用户命令；
      // 退出码经 err.code 兜底，但前缀提前退出会致 MARKER 未打印、本次 cwd 不更新。属病态 hook，不防御。
      // 捕获用户命令的退出码与结束时的 $PWD，与命令自身输出隔离
      const wrapped = `${prefixed(input.command)}\n__dc_ec=$?\nprintf '\\n${MARKER}%s|%s' "$PWD" "$__dc_ec"`
      execFile(
        '/bin/bash',
        ['-c', wrapped],
        { cwd: ctx.cwd(), timeout: input.timeout ?? 120_000, maxBuffer: 10 * 1024 * 1024, signal: ctx.signal },
        async (err: any, stdout, stderr) => {
          let out = stdout
          // Default: use err.code if numeric (e.g. `exit 3` terminates bash before marker is printed)
          let exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0
          const idx = out.lastIndexOf(MARKER)
          if (idx >= 0) {
            const tail = out.slice(idx + MARKER.length)
            out = out.slice(0, idx).replace(/\n$/, '')
            // 用 lastIndexOf：退出码永远是最后一个 | 之后的字段，$PWD 本身含 | 也不会解析错
            const sep = tail.lastIndexOf('|')
            const newCwd = tail.slice(0, sep)
            exitCode = Number(tail.slice(sep + 1)) || 0
            if (newCwd && newCwd !== ctx.cwd()) {
              const oldCwd = ctx.cwd()
              ctx.setCwd(newCwd)
              const sid = ctx.sessionId?.()
              if (sid) clearCwdEnvFiles(sid) // 清旧 cwd 专属 env，hook 重写新值
              await ctx.hookDispatch?.('CwdChanged', {
                hook_event_name: 'CwdChanged', cwd: newCwd, session_id: sid, old_cwd: oldCwd, new_cwd: newCwd,
              })?.catch(() => undefined)
              if (sid) invalidateSessionEnvCache(sid) // 下条命令重读前缀
            } else if (newCwd) {
              ctx.setCwd(newCwd)
            }
          }
          const merged = [out, stderr && `[stderr]\n${stderr}`].filter(Boolean).join('\n')
          if (err?.killed) {
            return resolve(truncateMiddle(`错误：命令超时（${input.timeout ?? 120_000}ms），已终止。\n${merged}`))
          }
          resolve(truncateMiddle(exitCode === 0 ? merged || '(无输出)' : `退出码 ${exitCode}\n${merged}`))
        },
      )
    })
  },
}
