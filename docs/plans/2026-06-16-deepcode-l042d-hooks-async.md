# L-042 ①d Hooks async / asyncRewake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 deepcode hooks 引擎加 async / asyncRewake 机制——command hook 可后台执行不阻塞，完成时经后台任务通知队列注入主循环；asyncRewake 在 exit 2 时唤醒模型。并 fold ①b-1 两个终审 minor。

**Architecture:** 全保真对齐 CC（`~/Desktop/src/utils/hooks.ts` + `AsyncHookRegistry.ts`）。引擎 `hooks.ts` **总是先 spawn**，两条 async 触发路径（配置 `async`/`asyncRewake` 字段；或 stdout 首行 `{"async":true,asyncTimeout?}`）。检测到 → 调注入的 `deps.registerAsync` 把已 spawn 的 child 交给新模块 `src/hookTasks.ts` 接管后台生命周期，引擎立即返 `{outcome:'backgrounded'}` 不阻塞。`hookTasks.ts` 复用 `tasks.ts` 的 `registerTask`/`enqueueNotification`（新 `TaskType:'local_hook'`），完成时解析 hook stdout JSON（剥首行 async marker）入通知队列；asyncRewake 仅 exit 2 入队唤醒。`hooks.ts` **不** import `tasks.ts`（保持解耦），单向依赖：`hookTasks.ts → hooks.ts` 纯函数 + `tasks.ts`。

**Tech Stack:** TypeScript / ESM / Node child_process / vitest。

**对齐要点（CC 实读结论）：**
- async 检测两路：配置 `hook.async || hook.asyncRewake`（CC `utils/hooks.ts:995`）；stdout 首行 JSON `{"async":true}`（CC `utils/hooks.ts:1112`，用 `firstLineOf` + `includes('}')` 判完整）。
- asyncRewake 蕴含 async；**仅 exit code 2** 把 `blockingError` 包成 task-notification 唤醒；非 2 静默（CC `utils/hooks.ts:236-243`）。
- 普通 async 完成：解析 stdout（跳过首行 `{"async":...}`），复用同步 hook 的字段映射，把 `additionalContext`/`systemMessage` 注入（CC `AsyncHookRegistry.ts:193-204`）。
- async 默认超时 **15s**，`asyncTimeout`（ms）覆盖（CC `AsyncHookRegistry.ts:51`）。
- fail-safe：无 `registerAsync` dep → async hook 退化为同步阻塞执行（对齐 CC `forceSyncExecution`）。

**不做（YAGNI / 既定推迟）：**
- `once` 字段消费：memory 钦定推迟到 L-022 skill 系统，本件保留字段不消费。
- async hook 不走 outputFile 落盘（短命、输出即解析入通知；与 local_bash 不同，`result` 字段承载解析后上下文）。

**测试基线命令：**
- 单测：`npm test -- <file>`（vitest）
- 全量：`npm test`
- 类型：`npm run typecheck`
- 构建：`npm run build`

---

### Task 1: `isAsyncFirstLine` 纯函数

检测 command hook stdout 首行是否为 async marker。纯函数，无 I/O。

**Files:**
- Modify: `src/hooks.ts`（紧跟现有 `parseHookEvalResult` 之后、`HOOK_EVAL_SYSTEM` 之前；或放在纯函数区 `mergeResults` 之后）
- Test: `test/hooks.test.ts`

- [ ] **Step 1: 写失败测试**

在 `test/hooks.test.ts` 末尾追加（确保顶部已 `import { ..., isAsyncFirstLine } from '../src/hooks.js'`）：

```ts
describe('isAsyncFirstLine', () => {
  it('合法 async marker → 解析', () => {
    expect(isAsyncFirstLine('{"async":true}')).toEqual({ async: true })
  })
  it('带 asyncTimeout（ms）', () => {
    expect(isAsyncFirstLine('{"async":true,"asyncTimeout":5000}')).toEqual({ async: true, asyncTimeout: 5000 })
  })
  it('async 非 true → null', () => {
    expect(isAsyncFirstLine('{"async":false}')).toBeNull()
  })
  it('无 async 字段 → null', () => {
    expect(isAsyncFirstLine('{"foo":1}')).toBeNull()
  })
  it('行不完整（无闭合括号）→ null', () => {
    expect(isAsyncFirstLine('{"async":tru')).toBeNull()
  })
  it('非 JSON → null', () => {
    expect(isAsyncFirstLine('hello world')).toBeNull()
  })
  it('asyncTimeout 非数字 → 忽略该字段', () => {
    expect(isAsyncFirstLine('{"async":true,"asyncTimeout":"x"}')).toEqual({ async: true })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- test/hooks.test.ts`
Expected: FAIL（`isAsyncFirstLine is not a function` / import 失败）

- [ ] **Step 3: 实现**

在 `src/hooks.ts` 的 `parseHookEvalResult` 函数定义之后插入：

```ts
/** 检测 command hook stdout 首行是否为 async marker `{"async":true,asyncTimeout?}`。
 *  对齐 CC firstLineOf + includes('}') 判完整；非 async/不完整/非 JSON → null。 */
export function isAsyncFirstLine(line: string): { async: true; asyncTimeout?: number } | null {
  if (!line.includes('}')) return null // 行尚不完整（对齐 CC：等更多数据）
  let json: any
  try { json = JSON.parse(line.trim()) } catch { return null }
  if (!json || typeof json !== 'object' || json.async !== true) return null
  const r: { async: true; asyncTimeout?: number } = { async: true }
  if (typeof json.asyncTimeout === 'number') r.asyncTimeout = json.asyncTimeout
  return r
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- test/hooks.test.ts`
Expected: PASS（含原有用例）

- [ ] **Step 5: 提交**

```bash
git add src/hooks.ts test/hooks.test.ts
git commit -m "feat(hooks): isAsyncFirstLine 纯函数 (L-042 ①d)"
```

---

### Task 2: `tasks.ts` 加 `local_hook` 任务类型

为 async hook 后台任务扩展 TaskType + 通知摘要 + 退出清理 + asyncRewake 标记字段。

**Files:**
- Modify: `src/tasks.ts:8`（TaskType）、`11-29`（BackgroundTask 加字段）、`85-96`（toNotification）、`170-178`（killRunningTasks）
- Test: `test/tasks.test.ts`

- [ ] **Step 1: 写失败测试**

在 `test/tasks.test.ts` 追加（顶部按需补 import `registerTask, enqueueNotification, drainNotifications, clearAllTasks, type BackgroundTask`）：

```ts
describe('local_hook 任务类型', () => {
  beforeEach(() => clearAllTasks())
  it('toNotification：local_hook 完成 → summary=命令钩子已完成 且带 result，无 outputFile', () => {
    const t: BackgroundTask = {
      id: 'h1', type: 'local_hook', status: 'completed', description: 'echo hi',
      startTime: 0, outputFile: '/x', outputOffset: 0, notified: false, result: '上下文文本',
    }
    registerTask(t)
    enqueueNotification(t)
    const [n] = drainNotifications()
    expect(n.summary).toBe('命令钩子已完成')
    expect(n.result).toBe('上下文文本')
    expect(n.outputFile).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- test/tasks.test.ts`
Expected: FAIL（summary 不等 / 类型不接受 'local_hook'）

- [ ] **Step 3: 实现**

`src/tasks.ts:8` 改：

```ts
export type TaskType = 'local_bash' | 'local_agent' | 'local_hook'
```

`BackgroundTask` 接口（`src/tasks.ts:11-29`）在 `result?: string` 之后追加字段：

```ts
  // hook 专有（async/asyncRewake）
  asyncRewake?: boolean
```

`toNotification`（`src/tasks.ts:85-96`）改为支持三类型：

```ts
function toNotification(task: BackgroundTask): TaskNotification {
  const kind = task.type === 'local_agent' ? '子代理' : task.type === 'local_hook' ? '命令钩子' : '命令'
  return {
    id: task.id,
    status: task.status,
    summary: `${kind}${statusZh(task.status)}`,
    result: (task.type === 'local_agent' || task.type === 'local_hook') ? task.result : undefined,
    outputFile: task.type === 'local_bash' ? task.outputFile : undefined,
  }
}
```

`killRunningTasks`（`src/tasks.ts:170-178`）的 try 分支加 local_hook 处理（async hook 非 detached，直接 child.kill）：

```ts
    try {
      if (t.type === 'local_bash') killProcessTree(t.child, 'SIGKILL')
      else if (t.type === 'local_hook') { try { t.child?.kill('SIGKILL') } catch { /* 尽力 */ } }
      else t.abortController?.abort()
    } catch { /* 尽力而为 */ }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- test/tasks.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tasks.ts test/tasks.test.ts
git commit -m "feat(tasks): local_hook 任务类型 + asyncRewake 标记 (L-042 ①d)"
```

---

### Task 3: `src/hookTasks.ts` —— registerAsync + parseAsyncHookOutput

后台 async hook 生命周期接管：接管已 spawn 的 child，注册 local_hook 任务，完成时解析输出入通知队列。

**Files:**
- Create: `src/hookTasks.ts`
- Test: `test/hookTasks.test.ts`

- [ ] **Step 1: 写失败测试**

Create `test/hookTasks.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { registerAsync, parseAsyncHookOutput } from '../src/hookTasks.js'
import { listTasks, drainNotifications, clearAllTasks } from '../src/tasks.js'

// 造假 child：可控 stdout/exit。spawn 已由引擎完成，此处直接喂 child。
function fakeChild() {
  const child: any = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  return child
}
function emit(child: any, stdout: string, code: number) {
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout))
    child.emit('close', code)
  })
}
const flush = () => new Promise(r => setTimeout(r, 0))

describe('parseAsyncHookOutput', () => {
  it('剥首行 async marker，提取 additionalContext', () => {
    const out = `{"async":true}\n${JSON.stringify({ hookSpecificOutput: { additionalContext: 'ctx' } })}`
    expect(parseAsyncHookOutput(out, 0, '')).toBe('ctx')
  })
  it('无 marker 首行直接解析', () => {
    const out = JSON.stringify({ systemMessage: 'sys' })
    expect(parseAsyncHookOutput(out, 0, '')).toBe('sys')
  })
  it('无可注入内容 → undefined', () => {
    expect(parseAsyncHookOutput('{"async":true}\nplain text', 0, '')).toBe('plain text')
    expect(parseAsyncHookOutput('{"async":true}\n', 0, '')).toBeUndefined()
  })
})

describe('registerAsync', () => {
  beforeEach(() => clearAllTasks())

  it('普通 async：注册 running 任务，完成后解析 stdout → 入通知队列', async () => {
    const child = fakeChild()
    registerAsync({ child, hook: { type: 'command', command: 'echo' }, payload: {}, label: 'echo' })
    expect(listTasks()[0].status).toBe('running')
    emit(child, `{"async":true}\n${JSON.stringify({ hookSpecificOutput: { additionalContext: '完成上下文' } })}`, 0)
    await flush()
    expect(listTasks()[0].status).toBe('completed')
    const notes = drainNotifications()
    expect(notes).toHaveLength(1)
    expect(notes[0].result).toBe('完成上下文')
  })

  it('普通 async 完成但无可注入内容 → 不入通知队列', async () => {
    const child = fakeChild()
    registerAsync({ child, hook: { type: 'command', command: 'x' }, payload: {}, label: 'x' })
    emit(child, '', 0)
    await flush()
    expect(drainNotifications()).toHaveLength(0)
  })

  it('asyncRewake exit 2 → 入通知队列，result=stderr', async () => {
    const child = fakeChild()
    registerAsync({ child, hook: { type: 'command', command: 'guard', asyncRewake: true }, payload: {}, label: 'guard' })
    queueMicrotask(() => { child.stderr.emit('data', Buffer.from('阻塞原因')); child.emit('close', 2) })
    await flush()
    const notes = drainNotifications()
    expect(notes).toHaveLength(1)
    expect(notes[0].result).toBe('阻塞原因')
    expect(notes[0].status).toBe('failed')
  })

  it('asyncRewake exit 0 → 静默，不入通知队列', async () => {
    const child = fakeChild()
    registerAsync({ child, hook: { type: 'command', command: 'guard', asyncRewake: true }, payload: {}, label: 'guard' })
    emit(child, '', 0)
    await flush()
    expect(drainNotifications()).toHaveLength(0)
    expect(listTasks()[0].status).toBe('completed')
  })

  it('超时 → kill child', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    registerAsync({ child, hook: { type: 'command', command: 'slow' }, payload: {}, label: 'slow', asyncTimeout: 50 })
    vi.advanceTimersByTime(60)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- test/hookTasks.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

Create `src/hookTasks.ts`：

```ts
// src/hookTasks.ts —— async/asyncRewake command hook 的后台生命周期接管（挂 tasks.ts）。
// 引擎 (hooks.ts) 已 spawn child，此处接管：注册 local_hook 任务、完成时解析输出入通知队列。
// 单向依赖：本模块 import hooks.ts 纯函数 + tasks.ts；hooks.ts 不 import 本模块（经 deps.registerAsync 注入）。
import type { ChildProcess } from 'node:child_process'
import { generateTaskId, registerTask, getTask, updateTask, enqueueNotification, type BackgroundTask } from './tasks.js'
import { isAsyncFirstLine, parseHookStdout, type CommandHook } from './hooks.js'

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

/** 普通 async 完成输出解析：剥首行 async marker，复用同步 hook 字段映射，
 *  把 additionalContext/systemMessage/blockingError 拼成可注入文本；无内容 → undefined。 */
export function parseAsyncHookOutput(stdout: string, code: number, stderr: string): string | undefined {
  const lines = stdout.split('\n')
  const body = (lines.length && isAsyncFirstLine(lines[0].trim())) ? lines.slice(1).join('\n') : stdout
  const r = parseHookStdout(body, code, stderr)
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- test/hookTasks.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/hookTasks.ts test/hookTasks.test.ts
git commit -m "feat(hooks): hookTasks registerAsync + parseAsyncHookOutput 后台接管 (L-042 ①d)"
```

---

### Task 4: 引擎 `hooks.ts` async 接线

`HookEngineDeps.registerAsync` + `execCommandHook` 支持两条 async 触发路径。

**Files:**
- Modify: `src/hooks.ts`（`HookEngineDeps` 加字段、`ResolvedHookDeps` 加字段、`execCommandHook` 重写、`execOneHook` 改传 deps、`runHooks` 组装 full 加 registerAsync）
- Test: `test/hooks.test.ts`

- [ ] **Step 1: 写失败测试**

`test/hooks.test.ts` 追加（`fakeChild` 已存在，复用；async 路径需让 child 先 emit 首行再不立即 close，故新增小 helper）：

```ts
describe('runHooks async', () => {
  it('配置 async:true → 调 registerAsync，返 backgrounded，不阻塞', async () => {
    const registerAsync = vi.fn()
    const spawn = vi.fn(() => fakeChild('', 0)) // 即便 child 会 close，配置级 async 已在 stdin 后 handoff
    const cfg: HooksConfig = { PreToolUse: [{ hooks: [{ type: 'command', command: 'bg', async: true }] }] }
    const o = await runHooks('PreToolUse', { tool_name: 'Write' }, cfg, { spawn, registerAsync })
    expect(registerAsync).toHaveBeenCalledTimes(1)
    expect(o.results[0].outcome).toBe('backgrounded')
    expect(o.block).toBe(false)
  })

  it('stdout 首行 {"async":true} → 调 registerAsync 并 handoff', async () => {
    const registerAsync = vi.fn()
    // child 仅 emit 首行 marker，不 close（模拟仍在后台跑）
    const child: any = new EventEmitter()
    child.stdin = { write: vi.fn(), end: vi.fn() }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = vi.fn()
    queueMicrotask(() => child.stdout.emit('data', Buffer.from('{"async":true}\n')))
    const spawn = vi.fn(() => child)
    const cfg: HooksConfig = { PreToolUse: [{ hooks: [{ type: 'command', command: 'maybe' }] }] }
    const o = await runHooks('PreToolUse', { tool_name: 'Write' }, cfg, { spawn, registerAsync })
    expect(registerAsync).toHaveBeenCalledTimes(1)
    expect(o.results[0].outcome).toBe('backgrounded')
  })

  it('fail-safe：配置 async 但无 registerAsync dep → 同步阻塞执行', async () => {
    const spawn = vi.fn(() => fakeChild(JSON.stringify({ hookSpecificOutput: { additionalContext: 'sync' } }), 0))
    const cfg: HooksConfig = { PreToolUse: [{ hooks: [{ type: 'command', command: 'bg', async: true }] }] }
    const o = await runHooks('PreToolUse', { tool_name: 'Write' }, cfg, { spawn })
    expect(o.results[0].outcome).toBe('success')
    expect(o.additionalContext).toBe('sync')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- test/hooks.test.ts`
Expected: FAIL（registerAsync 未被调用 / outcome 非 backgrounded）

- [ ] **Step 3: 实现**

`src/hooks.ts` 的 `HookEngineDeps`（现 166-176）在 `fetch?: typeof fetch` 之后追加字段：

```ts
  /** async/asyncRewake command hook：把已 spawn 的 child 交后台接管（挂 tasks.ts）。
   *  缺省 → async hook fail-safe 退化为同步阻塞执行（对齐 CC forceSyncExecution）。 */
  registerAsync?: (args: {
    child: import('node:child_process').ChildProcess
    hook: CommandHook
    payload: Record<string, unknown>
    label: string
    asyncTimeout?: number
    initialStdout?: string
    initialStderr?: string
  }) => void
```

`ResolvedHookDeps`（现 178-185）加 `registerAsync`：

```ts
interface ResolvedHookDeps {
  spawn: typeof nodeSpawn
  now: () => number
  sessionEnvBase: string
  fetch: typeof fetch
  llm?: HookEngineDeps['llm']
  runAgent?: HookEngineDeps['runAgent']
  registerAsync?: HookEngineDeps['registerAsync']
}
```

把 `execCommandHook`（现 188-211）整体替换为支持 async 的版本：

```ts
/** 单 command hook：spawn bash -c，payload JSON 写 stdin，超时 SIGKILL，close→parseHookStdout。
 *  async/asyncRewake：先 spawn 后判定（配置级 / stdout 首行 marker），命中 → registerAsync 接管返 backgrounded。 */
function execCommandHook(hook: CommandHook, payload: Record<string, unknown>, deps: ResolvedHookDeps, envFilePath?: string): Promise<HookResult> {
  return new Promise(resolve => {
    const timeoutMs = (hook.timeout ?? 60) * 1000
    const isAsyncConfig = !!(hook.async || hook.asyncRewake)
    const canAsync = !!deps.registerAsync
    const opts: SpawnOptions = {
      env: {
        ...process.env,
        DEEPCODE_PROJECT_DIR: process.cwd(),
        DEEPCODE_CWD: String(payload.cwd ?? ''),
        ...(envFilePath ? { DEEPCODE_ENV_FILE: envFilePath } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
    let child: any
    try { child = deps.spawn('/bin/bash', ['-c', hook.command], opts) } catch { return resolve({ outcome: 'non_blocking_error', label: hook.command, durationMs: 0 }) }
    let stdout = '', stderr = '', done = false, handed = false, initialChecked = false
    const finish = (r: HookResult) => { if (done || handed) return; done = true; clearTimeout(timer); resolve(r) }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 尽力 */ }; finish({ outcome: 'cancelled', label: hook.command, durationMs: 0 }) }, timeoutMs)
    const handOff = (asyncTimeout?: number) => {
      if (done || handed) return
      handed = true
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onErr)
      child.off('close', onClose)
      child.off('error', onError)
      deps.registerAsync!({ child, hook, payload, label: hook.command, asyncTimeout, initialStdout: stdout, initialStderr: stderr })
      resolve({ outcome: 'backgrounded', label: hook.command, durationMs: 0 })
    }
    const onData = (d: Buffer) => {
      stdout += d.toString()
      // stdout 首行 async 检测（仅在可 async 且非配置级 async 时）
      if (!initialChecked && canAsync && !isAsyncConfig) {
        const firstLine = stdout.split('\n')[0]
        if (firstLine.includes('}')) {
          initialChecked = true
          const parsed = isAsyncFirstLine(firstLine.trim())
          if (parsed) handOff(parsed.asyncTimeout)
        }
      }
    }
    const onErr = (d: Buffer) => { stderr += d.toString() }
    const onClose = (code: number | null) => finish(parseHookStdout(stdout, code ?? 0, stderr))
    const onError = () => finish({ outcome: 'non_blocking_error', label: hook.command, durationMs: 0 })
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onErr)
    child.on('error', onError)
    child.on('close', onClose)
    try { child.stdin?.write(JSON.stringify(payload) + '\n'); child.stdin?.end() } catch { /* 尽力 */ }
    // 配置级 async/asyncRewake：写完 stdin 立即 handoff（asyncTimeout 来自配置 timeout）。
    if (isAsyncConfig && canAsync) handOff(hook.timeout ? hook.timeout * 1000 : undefined)
  })
}
```

`execOneHook`（现 302-321）的 command 分支改为传 `deps`：

```ts
  if (hook.type === 'command') {
    const r = await execCommandHook(hook, payload, deps, envFilePath)
    return { ...r, label: hook.command, durationMs: deps.now() - start }
  }
```

`runHooks`（现 347-354）组装 `full` 时加 `registerAsync`：

```ts
  const full: ResolvedHookDeps = {
    spawn: deps.spawn ?? nodeSpawn,
    now: deps.now ?? Date.now,
    sessionEnvBase: deps.sessionEnvBase ?? DEFAULT_SESSION_ENV_BASE,
    fetch: deps.fetch ?? (globalThis.fetch as typeof fetch),
    llm: deps.llm,
    runAgent: deps.runAgent,
    registerAsync: deps.registerAsync,
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- test/hooks.test.ts`
Expected: PASS（含原有用例——同步 command 路径不受影响）

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: 干净（注意 `child` 在 `execCommandHook` 用 `any`，与原实现一致）

- [ ] **Step 6: 提交**

```bash
git add src/hooks.ts test/hooks.test.ts
git commit -m "feat(hooks): 引擎 async 两路检测 + registerAsync handoff (L-042 ①d)"
```

---

### Task 5: 接线 `makeHookRuntime` 注入 registerAsync

单点接线：`makeHookRuntime` 返回值加 `registerAsync` → useChat / headless / loop 全通道自动获得。

**Files:**
- Modify: `src/hookRuntime.ts`（import + 返回值 + 返回类型）
- Test: `test/hookRuntime.test.ts`

- [ ] **Step 1: 写失败测试**

`test/hookRuntime.test.ts` 追加：

```ts
describe('makeHookRuntime registerAsync', () => {
  it('返回的 deps 含 registerAsync', () => {
    const deps = makeHookRuntime({ client: {} as any, getModel: () => 'm', cwd: () => '/tmp' })
    expect(typeof deps.registerAsync).toBe('function')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- test/hookRuntime.test.ts`
Expected: FAIL（registerAsync undefined）

- [ ] **Step 3: 实现**

`src/hookRuntime.ts` 顶部 import 区加：

```ts
import { registerAsync } from './hookTasks.js'
```

返回类型（现 26）改：

```ts
}): Pick<HookEngineDeps, 'llm' | 'runAgent' | 'registerAsync'> {
```

返回语句（现 65）改：

```ts
  return { llm, runAgent, registerAsync }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- test/hookRuntime.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/hookRuntime.ts test/hookRuntime.test.ts
git commit -m "feat(hooks): makeHookRuntime 注入 registerAsync 接线 (L-042 ①d)"
```

---

### Task 6: fold minor ① —— PermissionDenied payload 补 `tool_input`

①b-1 终审遗留：PermissionDenied 事件 payload 缺 `tool_input`（对称性）。`onDenied` 闭包在 `execCall` 内、`input` 已在作用域，单行补字段即可——**无需改 `permissions.ts` 的 onDenied 签名**。

**Files:**
- Modify: `src/loop.ts:102`
- Test: `test/loop.hooks.test.ts`（若无该文件，加到已有覆盖 PermissionDenied 的测试文件；用 `grep -rl "PermissionDenied" test/` 定位）

- [ ] **Step 1: 写失败测试**

先定位现有 PermissionDenied 测试：`grep -rln "PermissionDenied" test/`。在该文件对应 describe 内追加（断言 hook 收到的 payload 含 `tool_input`）。模板（按现有测试夹具调整 mock 方式）：

```ts
it('PermissionDenied payload 含 tool_input', async () => {
  const seen: any[] = []
  const hooks: HooksConfig = { PermissionDenied: [{ hooks: [{ type: 'command', command: 'log' }] }] }
  // 用 spawn mock 记录写入 stdin 的 payload，或经现有 runHooks 注入夹具捕获 payload
  // 触发一次被拒绝的工具调用（permission.ask → 'no'），断言 captured payload.tool_input 存在且等于工具输入
  // ...（按 test/loop.hooks.test.ts 既有风格补全捕获逻辑）
  expect(seen[0].tool_input).toBeDefined()
})
```

> 实现者注：若既有测试夹具难以捕获 payload，最小可行替代——直接单测 onDenied 构造逻辑：在 loop 测试中 mock `deps.permission.ask` 返回 `'no'`，并用一个捕获型 `deps.hooks` 触发，断言 `runHooks` 收到的 PermissionDenied payload 带 `tool_input`。参照同文件 PreToolUse 已有断言写法。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- <PermissionDenied 测试文件>`
Expected: FAIL（tool_input undefined）

- [ ] **Step 3: 实现**

`src/loop.ts:102` 的 onDenied 内 runHooks payload 加 `tool_input: input`：

```ts
      onDenied: async (name: string, d: string, reason: string) => {
        await runHooks('PermissionDenied', { hook_event_name: 'PermissionDenied', cwd, tool_name: name, tool_input: input, tool_desc: d, reason }, deps.hooks, deps.hookDeps)
      },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- <PermissionDenied 测试文件>`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/loop.ts test/<file>
git commit -m "fix(hooks): PermissionDenied payload 补 tool_input (L-042 ①b-1 fold)"
```

---

### Task 7: fold minor ② —— headless block 路径带上 additionalContext

①b-1 终审遗留：headless 里 UserPromptSubmit hook `block`/`preventContinuation` 时丢弃了 `additionalContext`。block 时把 hook 返回的 additionalContext 一并带进返回文本。

**Files:**
- Modify: `src/headless.ts:80-82`
- Test: `test/headless.test.ts`

- [ ] **Step 1: 写失败测试**

`test/headless.test.ts` 追加（参照同文件既有 UserPromptSubmit/SessionStart mock runHooks 的写法；mock `config.loadSettings` 注入 UserPromptSubmit hook，mock runHooks 让 UserPromptSubmit 返回 `{ block:true, blockReason:'拒', additionalContext:'附加' }`）：

```ts
it('UserPromptSubmit block 时返回文本含 additionalContext', async () => {
  // mock：UserPromptSubmit → { block:true, blockReason:'拒', additionalContext:'附加上下文' }
  const res = await runHeadless({ /* 既有夹具参数 */ } as any)
  expect(res.status).toBe('aborted')
  expect(res.text).toContain('拒')
  expect(res.text).toContain('附加上下文')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- test/headless.test.ts`
Expected: FAIL（text 不含 additionalContext）

- [ ] **Step 3: 实现**

`src/headless.ts:80-82` 的 block 分支改：

```ts
    if (ups.block || ups.preventContinuation) {
      const extra = ups.additionalContext ? `\n\n<hook-context>\n${ups.additionalContext}\n</hook-context>` : ''
      return { text: `输入被 hook 拦截：${ups.blockReason ?? ''}${extra}`, status: 'aborted', turns: 0, usage: total, costUSD: 0 }
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- test/headless.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/headless.ts test/headless.test.ts
git commit -m "fix(hooks): headless block 路径带上 additionalContext (L-042 ①b-1 fold)"
```

---

### Task 8: 全量闸门 + 收尾

**Files:** 无新增

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全绿（505 基线 + 本件新增用例）

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 干净

- [ ] **Step 3: 构建**

Run: `npm run build`
Expected: 干净

- [ ] **Step 4: 若有未提交收尾改动则提交**

```bash
git status --short
# 如有则 git add -A && git commit -m "chore(hooks): L-042 ①d 收尾"
```

---

## Self-Review

**1. Spec coverage（对照 spec §1.4 / §4 / ①b-1 fold）：**
- `isAsyncFirstLine` 纯函数 → Task 1 ✅
- async hook（配置 + stdout 首行）后台不阻塞 → Task 4（引擎检测）+ Task 3（registerAsync 接管）✅
- asyncRewake exit 2 唤醒、非 2 静默 → Task 3 ✅
- 复用 registerTask/enqueueNotification/drainNotifications/formatNotification → Task 2/3 ✅
- 新 TaskType `local_hook` → Task 2 ✅
- 完成回调解析 hook stdout JSON（剥首行 marker）→ Task 3 `parseAsyncHookOutput` ✅
- 默认 15s 超时 + asyncTimeout 覆盖 → Task 3/4 ✅
- 三 dispatch 通道获得 registerAsync → Task 5（makeHookRuntime 单点）✅
- ①b-1 fold ① PermissionDenied tool_input → Task 6 ✅
- ①b-1 fold ② headless block additionalContext → Task 7 ✅
- `once` 字段：既定推迟 L-022，本件不做（已在 plan 头部声明）✅

**2. Placeholder scan：** Task 6/7 的测试夹具因依赖既有测试文件的 mock 风格，给了模板 + 实现者注（需按既有夹具补捕获逻辑）——非占位，是适配既有测试基建的必要留白；其余步骤均含完整代码。

**3. Type consistency：**
- `registerAsync` 签名在 `HookEngineDeps`（Task 4）、`RegisterAsyncArgs`（Task 3）、`makeHookRuntime` 返回（Task 5）三处一致：`{ child, hook, payload, label, asyncTimeout?, initialStdout?, initialStderr? }`。
- `TaskType` 'local_hook'（Task 2）在 `registerAsync`（Task 3）、`toNotification`/`killRunningTasks`（Task 2）一致使用。
- `parseAsyncHookOutput(stdout, code, stderr)` 签名在 Task 3 定义与测试一致。
- `isAsyncFirstLine` 返回 `{async:true, asyncTimeout?}`（Task 1）被 Task 3/4 消费，字段名一致。
