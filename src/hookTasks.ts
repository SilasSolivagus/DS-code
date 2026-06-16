// src/hookTasks.ts —— async/asyncRewake command hook 的后台生命周期接管（挂 tasks.ts）。
// 引擎 (hooks.ts) 已 spawn child，此处接管：注册 local_hook 任务、完成时解析输出入通知队列。
// 单向依赖：本模块 import hooks.ts 纯函数 + tasks.ts；hooks.ts 不 import 本模块（经 deps.registerAsync 注入）。
import type { ChildProcess } from 'node:child_process'
import { generateTaskId, registerTask, getTask, updateTask, enqueueNotification, type BackgroundTask } from './tasks.js'
import { isAsyncFirstLine, applyHookJson, type CommandHook } from './hooks.js'

const DEFAULT_ASYNC_TIMEOUT_MS = 15000 // 对齐 CC AsyncHookRegistry 默认 15s

export interface RegisterAsyncArgs {
  child: ChildProcess
  hook: CommandHook
  payload: Record<string, unknown>
  label: string
  asyncTimeout?: number   // ms（来自 stdout marker 或配置；缺省 15s）
  initialStdout?: string  // 引擎首行检测时已消费的 stdout（接续累加）
  initialStderr?: string
}

/** 普通 async 完成输出解析：剥首行 async marker，解析剩余 stdout JSON（**不按退出码门控**，对齐 CC
 *  checkForAsyncHookResponses），把 additionalContext/systemMessage/(decision:block 时)blockingError
 *  拼成可注入文本；非 JSON 体 → 原文当上下文；空 → undefined。 */
export function parseAsyncHookOutput(stdout: string, _code: number, _stderr: string): string | undefined {
  const lines = stdout.split('\n')
  const body = (lines.length && isAsyncFirstLine(lines[0].trim())) ? lines.slice(1).join('\n') : stdout
  const trimmed = body.trim()
  if (!trimmed) return undefined
  let json: any
  try { json = JSON.parse(trimmed) } catch { return trimmed } // 非 JSON 体 → 整段当注入上下文
  if (!json || typeof json !== 'object' || Array.isArray(json)) return trimmed
  const r = applyHookJson(json, { outcome: 'success', label: '', durationMs: 0 })
  const parts: string[] = []
  if (r.additionalContext) parts.push(r.additionalContext)
  if (r.systemMessage) parts.push(r.systemMessage)
  if (r.outcome === 'blocking' && r.blockingError) parts.push(r.blockingError)
  return parts.length ? parts.join('\n\n') : undefined
}

/** 接管已 spawn 的 async hook child。注册后台 local_hook 任务，完成时入通知队列。 */
export function registerAsync(args: RegisterAsyncArgs): void {
  const { child, hook, label } = args
  const timeoutMs = args.asyncTimeout ?? DEFAULT_ASYNC_TIMEOUT_MS
  const id = generateTaskId('local_bash') // 复用 ID 生成（'b' 前缀）；类型由 task.type 区分
  let stdout = args.initialStdout ?? ''
  let stderr = args.initialStderr ?? ''
  let settled = false
  const task: BackgroundTask = {
    id, type: 'local_hook', status: 'running', description: label,
    child, startTime: Date.now(), outputFile: '', outputOffset: 0, notified: false,
    asyncRewake: hook.asyncRewake,
  }
  registerTask(task)
  // 超时仅 kill；结算由随后的 close 事件触发（settled 守卫去重）。
  const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 尽力 */ } }, timeoutMs)
  child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
  child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
  const settle = (code: number) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (hook.asyncRewake) {
      // asyncRewake：仅 exit 2 唤醒；非 2 静默。
      if (code === 2) {
        updateTask(id, { status: 'failed', endTime: Date.now(), result: (stderr || stdout).trim() })
        enqueueNotification(getTask(id)!)
      } else {
        updateTask(id, { status: code === 0 ? 'completed' : 'failed', endTime: Date.now() })
      }
      return
    }
    // 普通 async：解析输出，有可注入内容才入队。
    const ctx = parseAsyncHookOutput(stdout, code, stderr)
    updateTask(id, { status: code === 0 ? 'completed' : 'failed', endTime: Date.now(), result: ctx })
    if (ctx) enqueueNotification(getTask(id)!)
  }
  child.once('close', (code: number | null) => settle(code ?? 0))
  child.once('error', () => { if (settled) return; settled = true; clearTimeout(timer); updateTask(id, { status: 'failed', endTime: Date.now() }) })
}
