// src/statusLine.ts —— 自定义状态栏命令：解析 + 执行 + 去抖/abort/缓存调度。
// 对齐 CC components/StatusLine.tsx：事件驱动 + 300ms 去抖 + 在途 abort + 5s 超时 + 缓存；失败静默保留上次值。
// CC stdout 解析保留多行（\n join）；deepcode footer 紧凑 → 单行 join(' ') + 长度截断（已记 spec 偏离）。
import { spawn as nodeSpawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'

export const STATUS_LINE_DEFAULT_TIMEOUT_MS = 5000
export const STATUS_LINE_DEFAULT_MAX_CHARS = 200

/** trim → 按行 trim 去空 → join 单行 → 截断（CC 同语义但单行化）。 */
export function parseStatusLineStdout(raw: string, maxChars = STATUS_LINE_DEFAULT_MAX_CHARS): string {
  const joined = raw.trim().split('\n').map(l => l.trim()).filter(Boolean).join(' ')
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined
}

/** spawn bash -c 跑命令，JSON input 写 stdin；5s 或外部 signal 中止则杀子进程；exit≠0/空/异常 → undefined（绝不抛）。 */
export function execStatusLineCommand(
  command: string,
  input: unknown,
  opts: { spawn?: typeof nodeSpawn; timeoutMs?: number; signal?: AbortSignal; maxChars?: number } = {},
): Promise<string | undefined> {
  const spawn = opts.spawn ?? nodeSpawn
  const timeoutMs = opts.timeoutMs ?? STATUS_LINE_DEFAULT_TIMEOUT_MS
  return new Promise<string | undefined>(resolve => {
    let done = false
    const finish = (v: string | undefined) => {
      if (done) return
      done = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve(v)
    }
    const spawnOpts: SpawnOptions = {
      env: { ...process.env, DEEPCODE_PROJECT_DIR: process.cwd() },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
    let child: ReturnType<typeof nodeSpawn>
    try { child = spawn('/bin/bash', ['-c', command], spawnOpts) } catch { return resolve(undefined) }
    const kill = () => { try { child.kill('SIGKILL') } catch { /* 尽力 */ } }
    const timer = setTimeout(() => { kill(); finish(undefined) }, timeoutMs)
    const onAbort = () => { kill(); finish(undefined) }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    let stdout = ''
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.on('error', () => finish(undefined))
    child.on('close', (code: number | null) => {
      if (code !== 0) return finish(undefined)
      const text = parseStatusLineStdout(stdout, opts.maxChars)
      finish(text || undefined) // 空输出当无
    })
    try { child.stdin?.write(JSON.stringify(input) + '\n'); child.stdin?.end() } catch { /* 尽力 */ }
  })
}

/** 去抖（300ms）+ 在途单飞 + 缓存的调度器。schedule() 触发；结果变化才 onChange。 */
export function createStatusLineRunner(opts: {
  exec: () => Promise<string | undefined>
  onChange: (text: string | undefined) => void
  debounceMs?: number
}): { schedule(): void; current(): string | undefined; dispose(): void } {
  const debounceMs = opts.debounceMs ?? 300
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let pendingWhileRunning = false
  let cache: string | undefined
  const doUpdate = async (): Promise<void> => {
    if (running) { pendingWhileRunning = true; return } // 在途则标记，跑完补一次（单飞）
    running = true
    try {
      const text = await opts.exec()
      if (text !== cache) { cache = text; opts.onChange(cache) }
    } catch { /* exec 自身已 fail-safe，这里再兜底 */ }
    finally {
      running = false
      if (pendingWhileRunning) { pendingWhileRunning = false; void doUpdate() }
    }
  }
  return {
    schedule() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = undefined; void doUpdate() }, debounceMs)
    },
    current() { return cache },
    dispose() { if (timer) clearTimeout(timer); timer = undefined },
  }
}
