# L-042 ①a Hooks 引擎地基 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 `src/hooks.ts` hooks 引擎地基（纯函数 + command 类型执行器 + 并行 + 优先级合并 + if 过滤 + 零开销短路），配置接入，并把 PreToolUse/PostToolUse/PostToolUseFailure 三事件接入 `execCall`（含权限集成）。

**Architecture:** 引擎对外只暴露 `runHooks(event, payload, config, deps)`；内部由纯函数（matchesMatcher/matchQueryFor/evalIfCondition/parseHookStdout/mergeResults）+ command 执行器组成，依赖（spawn/now）注入便于测。未配置某事件时 `runHooks` 立即返回空结果（零 spawn）。`execCall` 在 schema 解析后插 PreToolUse（deny/改写/allow）、`tool.call` 成功后插 PostToolUse、catch 插 PostToolUseFailure。

**Tech Stack:** TypeScript (ESM), zod, vitest, node:child_process。对齐 CC 源码 `~/Desktop/src`。设计见 `docs/specs/2026-06-16-deepcode-hooks-design.md`。

**范围边界（①a）：** 只做 command 类型（prompt/agent/http 留 ①c，default 分支返回 non_blocking_error 占位）；只接 3 个工具事件（其余 18 事件留 ①b）；async 留 ①d；不碰 TUI（免冒烟）。每任务 implementer + 双审；本架构件末加 opus 全量终审。

---

### Task 1: hooks.ts 骨架 + 类型 + matchesMatcher

**Files:**
- Create: `src/hooks.ts`
- Test: `test/hooks.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// test/hooks.test.ts
import { describe, it, expect, vi } from 'vitest'
import { matchesMatcher } from '../src/hooks.js'

describe('matchesMatcher', () => {
  it('undefined / 空串 / * → 恒匹配', () => {
    expect(matchesMatcher(undefined, 'Write')).toBe(true)
    expect(matchesMatcher('', 'Write')).toBe(true)
    expect(matchesMatcher('*', 'Write')).toBe(true)
  })
  it('简单标识符 → 精确匹配', () => {
    expect(matchesMatcher('Write', 'Write')).toBe(true)
    expect(matchesMatcher('Write', 'Edit')).toBe(false)
  })
  it('管道列表 → 多精确或', () => {
    expect(matchesMatcher('Write|Edit', 'Edit')).toBe(true)
    expect(matchesMatcher('Write|Edit', 'Read')).toBe(false)
  })
  it('正则 → 测试', () => {
    expect(matchesMatcher('^Wr.*', 'Write')).toBe(true)
    expect(matchesMatcher('^Ed.*', 'Write')).toBe(false)
  })
  it('非法正则 → false（不抛）', () => {
    expect(matchesMatcher('[invalid(', 'Write')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/hooks.test.ts`
Expected: FAIL（`matchesMatcher` is not exported / not defined）

- [ ] **Step 3: 写最小实现**

```ts
// src/hooks.ts
import { spawn as nodeSpawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import { matchRule } from './permissions.js'

export const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'SessionStart', 'SessionEnd', 'Setup', 'UserPromptSubmit',
  'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact',
  'PermissionRequest', 'PermissionDenied',
  'TaskCreated', 'TaskCompleted',
  'Notification', 'ConfigChange', 'CwdChanged', 'InstructionsLoaded',
  // 缺依赖、本件不 dispatch、随子系统点亮
  'WorktreeCreate', 'WorktreeRemove', 'Elicitation', 'ElicitationResult',
  'TeammateIdle', 'FileChanged',
] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

interface HookCommon { timeout?: number; if?: string; once?: boolean; statusMessage?: string }
export interface CommandHook extends HookCommon { type: 'command'; command: string; async?: boolean; asyncRewake?: boolean }
export interface PromptHook extends HookCommon { type: 'prompt'; prompt: string; model?: string }
export interface AgentHook extends HookCommon { type: 'agent'; prompt: string; model?: string }
export interface HttpHook extends HookCommon { type: 'http'; url: string; headers?: Record<string, string> }
export type HookCommand = CommandHook | PromptHook | AgentHook | HttpHook
export interface HookMatcher { matcher?: string; hooks: HookCommand[] }
export type HooksConfig = Partial<Record<HookEvent, HookMatcher[]>>

export interface HookResult {
  outcome: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled' | 'backgrounded'
  permissionDecision?: 'allow' | 'deny' | 'ask'
  permissionReason?: string
  updatedInput?: unknown
  updatedOutput?: string
  additionalContext?: string
  systemMessage?: string
  stop?: boolean
  preventContinuation?: boolean
  blockingError?: string
  label: string
  durationMs: number
}

export interface HookOutcome {
  block: boolean
  blockReason?: string
  permission?: 'allow' | 'deny' | 'ask'
  permissionReason?: string
  updatedInput?: unknown
  updatedOutput?: string
  additionalContext?: string
  systemMessage?: string
  preventContinuation: boolean
  stop: boolean
  results: HookResult[]
}

/** matcher 匹配：undefined/''/'*' 恒真；纯标识符精确；含 | 管道精确或；否则当正则（构造失败→false）。 */
export function matchesMatcher(matcher: string | undefined, query: string): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true
  if (matcher.includes('|')) return matcher.split('|').map(s => s.trim()).includes(query)
  if (/^[A-Za-z0-9_]+$/.test(matcher)) return matcher === query
  try { return new RegExp(matcher).test(query) } catch { return false }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/hooks.test.ts`
Expected: PASS（5 例）

- [ ] **Step 5: 提交**

```bash
git add src/hooks.ts test/hooks.test.ts
git commit -m "feat(hooks): hooks.ts 骨架 + 类型 + matchesMatcher (L-042 ①a)"
```

---

### Task 2: matchQueryFor + evalIfCondition

**Files:**
- Modify: `src/hooks.ts`
- Test: `test/hooks.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 test/hooks.test.ts
import { matchQueryFor, evalIfCondition } from '../src/hooks.js'

describe('matchQueryFor', () => {
  it('工具类 → tool_name', () => {
    expect(matchQueryFor('PreToolUse', { tool_name: 'Write' })).toBe('Write')
    expect(matchQueryFor('PostToolUse', { tool_name: 'Bash' })).toBe('Bash')
  })
  it('SessionStart → source；PreCompact → trigger；SubagentStop → agent_type', () => {
    expect(matchQueryFor('SessionStart', { source: 'startup' })).toBe('startup')
    expect(matchQueryFor('PreCompact', { trigger: 'auto' })).toBe('auto')
    expect(matchQueryFor('SubagentStop', { agent_type: 'Explore' })).toBe('Explore')
  })
  it('matcher 忽略类（TaskCreated/Stop）→ undefined', () => {
    expect(matchQueryFor('TaskCreated', {})).toBeUndefined()
    expect(matchQueryFor('Stop', {})).toBeUndefined()
  })
})

describe('evalIfCondition', () => {
  it('无 if → true', () => {
    expect(evalIfCondition(undefined, 'Bash', 'npm test')).toBe(true)
  })
  it('裸工具名 → 仅比工具名', () => {
    expect(evalIfCondition('Bash', 'Bash', 'whatever')).toBe(true)
    expect(evalIfCondition('Bash', 'Write', 'whatever')).toBe(false)
  })
  it('Tool(pat) → 复用 matchRule（:* 前缀）', () => {
    expect(evalIfCondition('Bash(npm test:*)', 'Bash', 'npm test -- foo')).toBe(true)
    expect(evalIfCondition('Bash(npm test:*)', 'Bash', 'rm -rf /')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/hooks.test.ts`
Expected: FAIL（`matchQueryFor` / `evalIfCondition` not defined）

- [ ] **Step 3: 写最小实现（追加到 src/hooks.ts）**

```ts
/** 各事件 matcher 匹配的 payload 字段；返回 undefined = 该事件忽略 matcher（恒匹配）。 */
export function matchQueryFor(event: HookEvent, payload: Record<string, unknown>): string | undefined {
  const s = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string) : undefined)
  switch (event) {
    case 'PreToolUse': case 'PostToolUse': case 'PostToolUseFailure':
    case 'PermissionRequest': case 'PermissionDenied':
      return s('tool_name')
    case 'SessionStart': case 'ConfigChange': return s('source')
    case 'Setup': case 'PreCompact': case 'PostCompact': return s('trigger')
    case 'Notification': return s('notification_type')
    case 'SessionEnd': return s('reason')
    case 'SubagentStart': case 'SubagentStop': return s('agent_type')
    case 'InstructionsLoaded': return s('load_reason')
    case 'FileChanged': return s('file_basename')
    default: return undefined
  }
}

/** if 条件求值（仅工具类事件有意义）：裸 'Tool' 仅比工具名；'Tool(pat)' 复用 permissions.matchRule。 */
export function evalIfCondition(ifExpr: string | undefined, toolName: string, desc: string): boolean {
  if (!ifExpr) return true
  if (/^[A-Za-z0-9_]+$/.test(ifExpr)) return ifExpr === toolName
  return matchRule(ifExpr, toolName, desc)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/hooks.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/hooks.ts test/hooks.test.ts
git commit -m "feat(hooks): matchQueryFor + evalIfCondition (L-042 ①a)"
```

---

### Task 3: parseHookStdout

**Files:**
- Modify: `src/hooks.ts`
- Test: `test/hooks.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// 追加
import { parseHookStdout } from '../src/hooks.js'

describe('parseHookStdout', () => {
  it('exit 2 → blocking + preventContinuation + stderr 作 reason', () => {
    const r = parseHookStdout('', 2, '安全审计失败')
    expect(r.outcome).toBe('blocking')
    expect(r.blockingError).toBe('安全审计失败')
    expect(r.preventContinuation).toBe(true)
  })
  it('exit 非 0 非 2 → non_blocking_error', () => {
    expect(parseHookStdout('', 1, 'boom').outcome).toBe('non_blocking_error')
  })
  it('exit 0 空输出 → success', () => {
    expect(parseHookStdout('', 0, '').outcome).toBe('success')
  })
  it('exit 0 非 JSON → success + additionalContext', () => {
    const r = parseHookStdout('hello world', 0, '')
    expect(r.outcome).toBe('success')
    expect(r.additionalContext).toBe('hello world')
  })
  it('exit 0 JSON permissionDecision deny', () => {
    const r = parseHookStdout(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: '禁止' } }), 0, '')
    expect(r.permissionDecision).toBe('deny')
    expect(r.permissionReason).toBe('禁止')
  })
  it('exit 0 JSON updatedInput + additionalContext', () => {
    const r = parseHookStdout(JSON.stringify({ hookSpecificOutput: { updatedInput: { path: '/safe' }, additionalContext: '已改写' } }), 0, '')
    expect(r.updatedInput).toEqual({ path: '/safe' })
    expect(r.additionalContext).toBe('已改写')
  })
  it('exit 0 JSON decision:block → blocking', () => {
    const r = parseHookStdout(JSON.stringify({ decision: 'block', reason: 'no' }), 0, '')
    expect(r.outcome).toBe('blocking')
    expect(r.blockingError).toBe('no')
  })
  it('exit 0 JSON continue:false → stop', () => {
    expect(parseHookStdout(JSON.stringify({ continue: false }), 0, '').stop).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/hooks.test.ts`
Expected: FAIL（`parseHookStdout` not defined）

- [ ] **Step 3: 写最小实现（追加到 src/hooks.ts）**

```ts
/** 单 hook 的 stdout/exit 解析成 HookResult（label/durationMs 由调用方补）。 */
export function parseHookStdout(stdout: string, exitCode: number, stderr: string): HookResult {
  const base: HookResult = { outcome: 'success', label: '', durationMs: 0 }
  if (exitCode === 2) {
    return { ...base, outcome: 'blocking', blockingError: (stderr || stdout || '').trim(), preventContinuation: true }
  }
  if (exitCode !== 0) {
    return { ...base, outcome: 'non_blocking_error', blockingError: (stderr || stdout || '').trim() || undefined }
  }
  const trimmed = stdout.trim()
  if (!trimmed) return base
  let json: any
  try { json = JSON.parse(trimmed) } catch { return { ...base, additionalContext: trimmed } }
  if (json === null || typeof json !== 'object') return { ...base, additionalContext: trimmed }
  const r: HookResult = { ...base }
  if (json.continue === false) r.stop = true
  if (json.decision === 'block') { r.outcome = 'blocking'; r.blockingError = typeof json.reason === 'string' ? json.reason : undefined; r.preventContinuation = true }
  if (json.decision === 'approve') r.permissionDecision = 'allow'
  if (typeof json.systemMessage === 'string') r.systemMessage = json.systemMessage
  const hso = json.hookSpecificOutput
  if (hso && typeof hso === 'object') {
    if (hso.permissionDecision === 'allow' || hso.permissionDecision === 'deny' || hso.permissionDecision === 'ask') r.permissionDecision = hso.permissionDecision
    const pr = hso.permissionReason ?? hso.permissionDecisionReason
    if (typeof pr === 'string') r.permissionReason = pr
    if ('updatedInput' in hso) r.updatedInput = hso.updatedInput
    if (typeof hso.updatedOutput === 'string') r.updatedOutput = hso.updatedOutput
    if (typeof hso.additionalContext === 'string') r.additionalContext = hso.additionalContext
  }
  return r
}
```

> 注：`HookResult` 不含 `stopReason` 字段，上面 `r.stopReason` 行删去——只保留 `r.stop = true`。最终实现：
> ```ts
> if (json.continue === false) r.stop = true
> ```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/hooks.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/hooks.ts test/hooks.test.ts
git commit -m "feat(hooks): parseHookStdout (L-042 ①a)"
```

---

### Task 4: mergeResults

**Files:**
- Modify: `src/hooks.ts`
- Test: `test/hooks.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// 追加
import { mergeResults, type HookResult } from '../src/hooks.js'

const mk = (over: Partial<HookResult>): HookResult => ({ outcome: 'success', label: 'h', durationMs: 1, ...over })

describe('mergeResults', () => {
  it('任一 blocking / deny → block，取首个 reason', () => {
    const o = mergeResults([mk({ outcome: 'success' }), mk({ outcome: 'blocking', blockingError: 'X' })], 'PreToolUse')
    expect(o.block).toBe(true)
    expect(o.blockReason).toBe('X')
  })
  it('优先级 deny > ask > allow', () => {
    expect(mergeResults([mk({ permissionDecision: 'allow' }), mk({ permissionDecision: 'ask' }), mk({ permissionDecision: 'deny' })], 'PreToolUse').permission).toBe('deny')
    expect(mergeResults([mk({ permissionDecision: 'allow' }), mk({ permissionDecision: 'ask' })], 'PreToolUse').permission).toBe('ask')
    expect(mergeResults([mk({ permissionDecision: 'allow' })], 'PreToolUse').permission).toBe('allow')
  })
  it('updatedInput / updatedOutput 取配置序最后一个非空', () => {
    const o = mergeResults([mk({ updatedInput: { a: 1 } }), mk({ updatedInput: { a: 2 } })], 'PreToolUse')
    expect(o.updatedInput).toEqual({ a: 2 })
  })
  it('additionalContext / systemMessage 累加（\\n\\n 连接）', () => {
    const o = mergeResults([mk({ additionalContext: 'A' }), mk({ additionalContext: 'B' })], 'PostToolUse')
    expect(o.additionalContext).toBe('A\n\nB')
  })
  it('preventContinuation / stop 任一为真', () => {
    expect(mergeResults([mk({}), mk({ preventContinuation: true })], 'Stop').preventContinuation).toBe(true)
    expect(mergeResults([mk({ stop: true })], 'Stop').stop).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/hooks.test.ts`
Expected: FAIL（`mergeResults` not defined）

- [ ] **Step 3: 写最小实现（追加到 src/hooks.ts）**

```ts
/** 并行结果按配置序合并：block=任一 blocking/deny；权限 deny>ask>allow；input/output 末个非空；context/sys 累加。 */
export function mergeResults(results: HookResult[], _event: HookEvent): HookOutcome {
  const out: HookOutcome = { block: false, preventContinuation: false, stop: false, results }
  const ctx: string[] = []
  const sys: string[] = []
  const perms: Array<'allow' | 'deny' | 'ask'> = []
  for (const r of results) {
    if (r.outcome === 'blocking' || r.permissionDecision === 'deny') {
      out.block = true
      if (out.blockReason === undefined) out.blockReason = r.blockingError ?? r.permissionReason
    }
    if (r.preventContinuation) out.preventContinuation = true
    if (r.stop) out.stop = true
    if (r.permissionDecision) perms.push(r.permissionDecision)
    if (r.permissionReason && out.permissionReason === undefined) out.permissionReason = r.permissionReason
    if (r.updatedInput !== undefined) out.updatedInput = r.updatedInput
    if (r.updatedOutput !== undefined) out.updatedOutput = r.updatedOutput
    if (r.additionalContext) ctx.push(r.additionalContext)
    if (r.systemMessage) sys.push(r.systemMessage)
  }
  if (perms.includes('deny')) out.permission = 'deny'
  else if (perms.includes('ask')) out.permission = 'ask'
  else if (perms.includes('allow')) out.permission = 'allow'
  if (ctx.length) out.additionalContext = ctx.join('\n\n')
  if (sys.length) out.systemMessage = sys.join('\n\n')
  return out
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/hooks.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/hooks.ts test/hooks.test.ts
git commit -m "feat(hooks): mergeResults 优先级合并 (L-042 ①a)"
```

---

### Task 5: runHooks + command 执行器（注入假 spawn）

**Files:**
- Modify: `src/hooks.ts`
- Test: `test/hooks.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// 追加
import { EventEmitter } from 'node:events'
import { runHooks, type HooksConfig } from '../src/hooks.js'

// 造假 child：可控 stdout/stderr/exit；记录 stdin。
function fakeChild(stdout: string, code: number, stderr = '') {
  const child: any = new EventEmitter()
  child.stdin = { write: vi.fn(), end: vi.fn() }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout))
    if (stderr) child.stderr.emit('data', Buffer.from(stderr))
    child.emit('close', code)
  })
  return child
}

describe('runHooks', () => {
  it('未配置该事件 → 零开销，spawn 不被调用', async () => {
    const spawn = vi.fn()
    const o = await runHooks('PreToolUse', { tool_name: 'Write' }, undefined, { spawn })
    expect(o.results).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
  })
  it('command 类型：写 stdin payload + 解析 exit 0 JSON', async () => {
    const spawn = vi.fn(() => fakeChild(JSON.stringify({ hookSpecificOutput: { additionalContext: 'ok' } }), 0))
    const cfg: HooksConfig = { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo hi' }] }] }
    const o = await runHooks('PreToolUse', { tool_name: 'Write', tool_input: { a: 1 } }, cfg, { spawn })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(o.additionalContext).toBe('ok')
    expect(o.results[0].label).toBe('echo hi')
  })
  it('matcher 不匹配 → 不 spawn', async () => {
    const spawn = vi.fn(() => fakeChild('', 0))
    const cfg: HooksConfig = { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'x' }] }] }
    await runHooks('PreToolUse', { tool_name: 'Write' }, cfg, { spawn })
    expect(spawn).not.toHaveBeenCalled()
  })
  it('if 不匹配 → 跳过该 hook', async () => {
    const spawn = vi.fn(() => fakeChild('', 0))
    const cfg: HooksConfig = { PreToolUse: [{ hooks: [{ type: 'command', command: 'x', if: 'Bash(git:*)' }] }] }
    await runHooks('PreToolUse', { tool_name: 'Bash', tool_desc: 'npm test' }, cfg, { spawn })
    expect(spawn).not.toHaveBeenCalled()
  })
  it('exit 2 → block', async () => {
    const spawn = vi.fn(() => fakeChild('', 2, '拒绝'))
    const cfg: HooksConfig = { PreToolUse: [{ hooks: [{ type: 'command', command: 'guard' }] }] }
    const o = await runHooks('PreToolUse', { tool_name: 'Write' }, cfg, { spawn })
    expect(o.block).toBe(true)
    expect(o.blockReason).toBe('拒绝')
  })
  it('未支持类型（prompt）→ non_blocking_error 占位，不崩', async () => {
    const cfg: HooksConfig = { PreToolUse: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }] }
    const o = await runHooks('PreToolUse', { tool_name: 'Write' }, cfg, {})
    expect(o.results[0].outcome).toBe('non_blocking_error')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/hooks.test.ts`
Expected: FAIL（`runHooks` not defined）

- [ ] **Step 3: 写最小实现（追加到 src/hooks.ts）**

```ts
export interface HookEngineDeps {
  spawn?: typeof nodeSpawn
  now?: () => number
}

/** 单 command hook：spawn bash -c，payload JSON 写 stdin，超时 SIGKILL，close→parseHookStdout。 */
function execCommandHook(hook: CommandHook, payload: Record<string, unknown>, spawn: typeof nodeSpawn): Promise<HookResult> {
  return new Promise(resolve => {
    const timeoutMs = (hook.timeout ?? 60) * 1000
    const opts: SpawnOptions = {
      env: { ...process.env, DEEPCODE_PROJECT_DIR: process.cwd(), DEEPCODE_CWD: String(payload.cwd ?? '') },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
    let child: any
    try { child = spawn('/bin/bash', ['-c', hook.command], opts) } catch { return resolve({ outcome: 'non_blocking_error', label: hook.command, durationMs: 0 }) }
    let stdout = '', stderr = '', done = false
    const finish = (r: HookResult) => { if (done) return; done = true; clearTimeout(timer); resolve(r) }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 尽力 */ }; finish({ outcome: 'cancelled', label: hook.command, durationMs: 0 }) }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', () => finish({ outcome: 'non_blocking_error', label: hook.command, durationMs: 0 }))
    child.on('close', (code: number | null) => finish(parseHookStdout(stdout, code ?? 0, stderr)))
    try { child.stdin?.write(JSON.stringify(payload) + '\n'); child.stdin?.end() } catch { /* 尽力 */ }
  })
}

/** 单 hook 分派：①a 仅 command；其余类型占位（①c 接）。 */
async function execOneHook(hook: HookCommand, payload: Record<string, unknown>, deps: Required<HookEngineDeps>): Promise<HookResult> {
  const start = deps.now()
  if (hook.type === 'command') {
    const r = await execCommandHook(hook, payload, deps.spawn)
    return { ...r, label: hook.command, durationMs: deps.now() - start }
  }
  return { outcome: 'non_blocking_error', label: `(${hook.type} 未支持)`, durationMs: deps.now() - start }
}

/** 引擎入口：选 matcher → 过 if → 并行执行 → 合并。未配置该事件→零开销空结果。 */
export async function runHooks(
  event: HookEvent,
  payload: Record<string, unknown>,
  config: HooksConfig | undefined,
  deps: HookEngineDeps = {},
): Promise<HookOutcome> {
  const empty: HookOutcome = { block: false, preventContinuation: false, stop: false, results: [] }
  const matchers = config?.[event]
  if (!matchers || matchers.length === 0) return empty

  const query = matchQueryFor(event, payload)
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : ''
  const desc = typeof payload.tool_desc === 'string' ? payload.tool_desc : ''
  const selected: HookCommand[] = []
  for (const m of matchers) {
    if (query !== undefined && !matchesMatcher(m.matcher, query)) continue
    for (const h of m.hooks) {
      if (h.if && !evalIfCondition(h.if, toolName, desc)) continue
      selected.push(h)
    }
  }
  if (selected.length === 0) return empty

  const full: Required<HookEngineDeps> = { spawn: deps.spawn ?? nodeSpawn, now: deps.now ?? Date.now }
  const results = await Promise.all(selected.map(h => execOneHook(h, payload, full)))
  return mergeResults(results, event)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/hooks.test.ts`
Expected: PASS（全部）

- [ ] **Step 5: 提交**

```bash
git add src/hooks.ts test/hooks.test.ts
git commit -m "feat(hooks): runHooks 引擎 + command 执行器 + 零开销短路 (L-042 ①a)"
```

---

### Task 6: 配置接入（Settings.hooks + loadSettings 宽松解析）

**Files:**
- Modify: `src/config.ts:6-20`（Settings 接口）、`src/config.ts:33-49`（loadSettings）
- Test: `test/config.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 test/config.test.ts（仿现有用例风格；若现有用例 mock 了 fs，沿用其 mock）
import { describe, it, expect } from 'vitest'
import { parseHooksConfig } from '../src/config.js'

describe('parseHooksConfig', () => {
  it('合法 hooks 原样返回', () => {
    const raw = { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'x' }] }] }
    expect(parseHooksConfig(raw)).toEqual(raw)
  })
  it('非对象 → undefined', () => {
    expect(parseHooksConfig(null)).toBeUndefined()
    expect(parseHooksConfig('x')).toBeUndefined()
  })
  it('丢弃未知事件键与结构非法的 matcher 条目', () => {
    const raw = { Bogus: [{ hooks: [] }], PreToolUse: [{ hooks: [{ type: 'command', command: 'ok' }] }, { foo: 1 }] }
    const out = parseHooksConfig(raw)!
    expect(out.Bogus).toBeUndefined()
    expect(out.PreToolUse!.length).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL（`parseHooksConfig` not defined）

- [ ] **Step 3: 写最小实现**

在 `src/config.ts` 顶部 import：
```ts
import { HOOK_EVENTS, type HooksConfig, type HookEvent } from './hooks.js'
```

`Settings` 接口加字段（在 `inline?` 后）：
```ts
  /** hooks 生命周期配置（会话启动快照；见 src/hooks.ts） */
  hooks?: HooksConfig
```

新增导出函数（宽松解析，结构非法即丢弃，不崩）：
```ts
/** 宽松解析 settings.hooks：只留已知事件键、matcher 为对象数组、hooks 为对象数组的条目。非对象→undefined。 */
export function parseHooksConfig(raw: unknown): HooksConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: HooksConfig = {}
  const known = new Set<string>(HOOK_EVENTS)
  for (const [event, matchers] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(event) || !Array.isArray(matchers)) continue
    const valid = matchers.filter(
      (m): m is { matcher?: string; hooks: unknown[] } =>
        !!m && typeof m === 'object' && Array.isArray((m as any).hooks) &&
        (m as any).hooks.every((h: any) => h && typeof h === 'object' && typeof h.type === 'string'),
    )
    if (valid.length) (out as any)[event as HookEvent] = valid
  }
  return Object.keys(out).length ? out : undefined
}
```

在 `loadSettings` 的 return 对象里加：
```ts
    hooks: parseHooksConfig(raw?.hooks),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/config.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(config): Settings.hooks + parseHooksConfig 宽松解析 (L-042 ①a)"
```

---

### Task 7: execCall 接入 PreToolUse / PostToolUse / PostToolUseFailure

**Files:**
- Modify: `src/loop.ts:16-33`（LoopDeps 加 hooks）、`src/loop.ts:58-86`（execCall）、顶部 import
- Test: `test/loop.test.ts`

- [ ] **Step 1: 写失败测试**

`execCall` 未导出 → 通过 `runLoop` 跑一轮覆盖（沿用 test/loop.test.ts 顶部已有的脚本化 `chatStream` mock + `script` + `drain`）。hooks 用**真实** command（`echo`/`printf`/`exit`，瞬时确定，无需 mock spawn）。断言落在回灌的 `role:'tool'` 消息 content 与工具收到的入参上。

```ts
// 追加到 test/loop.test.ts（文件顶部已 import vi/describe/it/expect、runLoop、LoopDeps、drain、script、makeDeps）
import { z } from 'zod'

// 记录收到入参、固定返回 ORIGINAL 的非只读工具
function recTool() {
  const calls: any[] = []
  const tool = {
    name: 'Rec', description: 'rec',
    inputSchema: z.object({ v: z.string() }),
    isReadOnly: false,
    needsPermission: () => 'rec-desc',
    call: async (input: any) => { calls.push(input); return 'ORIGINAL' },
  }
  return { tool, calls }
}

// 驱动一轮 Rec 工具调用 + 收尾；返回回灌的 tool 消息 content。
async function runOneToolCall(deps: LoopDeps, args = { v: 'orig' }) {
  script.push(
    { result: { content: '', toolCalls: [{ id: 't1', name: 'Rec', args: JSON.stringify(args) }], usage, finishReason: 'tool_calls' } },
    { result: { content: '完', toolCalls: [], usage, finishReason: 'stop' } },
  )
  const messages: any[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'go' }]
  await drain(runLoop(messages, deps))
  return messages.find(m => m.role === 'tool')?.content as string
}

describe('execCall + hooks', () => {
  it('PreToolUse exit 2 → 工具不执行，结果含阻止文案', async () => {
    const { tool, calls } = recTool()
    const deps = makeDeps([tool])
    deps.hooks = { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo 拒绝 1>&2; exit 2' }] }] }
    const content = await runOneToolCall(deps)
    expect(calls.length).toBe(0)
    expect(content).toContain('PreToolUse hook 阻止')
    expect(content).toContain('拒绝')
  })

  it('PreToolUse updatedInput 合法 → 工具收到改写后入参', async () => {
    const { tool, calls } = recTool()
    const deps = makeDeps([tool])
    deps.hooks = { PreToolUse: [{ hooks: [{ type: 'command', command: `printf '%s' '{"hookSpecificOutput":{"updatedInput":{"v":"CHANGED"}}}'` }] }] }
    await runOneToolCall(deps, { v: 'orig' })
    expect(calls[0].v).toBe('CHANGED')
  })

  it('PreToolUse updatedInput 不符合 schema → 拒绝执行', async () => {
    const { tool, calls } = recTool()
    const deps = makeDeps([tool])
    deps.hooks = { PreToolUse: [{ hooks: [{ type: 'command', command: `printf '%s' '{"hookSpecificOutput":{"updatedInput":{"v":123}}}'` }] }] }
    const content = await runOneToolCall(deps)
    expect(calls.length).toBe(0)
    expect(content).toContain('不符合工具 schema')
  })

  it('PreToolUse permission allow → 跳过 ask，工具执行', async () => {
    const { tool, calls } = recTool()
    const ask = vi.fn(async () => 'yes' as const)
    const deps = makeDeps([tool])
    deps.permission = { mode: 'default', rules: [], saveRule: () => {}, ask }
    deps.hooks = { PreToolUse: [{ hooks: [{ type: 'command', command: `printf '%s' '{"hookSpecificOutput":{"permissionDecision":"allow"}}'` }] }] }
    await runOneToolCall(deps)
    expect(ask).not.toHaveBeenCalled()
    expect(calls.length).toBe(1)
  })

  it('PostToolUse updatedOutput → 替换工具结果', async () => {
    const { tool } = recTool()
    const deps = makeDeps([tool])
    deps.hooks = { PostToolUse: [{ hooks: [{ type: 'command', command: `printf '%s' '{"hookSpecificOutput":{"updatedOutput":"REPLACED"}}'` }] }] }
    const content = await runOneToolCall(deps)
    expect(content).toBe('REPLACED')
  })

  it('PostToolUse additionalContext → 追加 <hook-context>', async () => {
    const { tool } = recTool()
    const deps = makeDeps([tool])
    deps.hooks = { PostToolUse: [{ hooks: [{ type: 'command', command: `printf '%s' '{"hookSpecificOutput":{"additionalContext":"NOTE"}}'` }] }] }
    const content = await runOneToolCall(deps)
    expect(content).toContain('ORIGINAL')
    expect(content).toContain('<hook-context>')
    expect(content).toContain('NOTE')
  })
})
```

> 注：`makeDeps` 默认 `permission.mode: 'yolo'`（非只读工具直接放行），故除"allow 跳过 ask"用例显式改 `mode:'default'` 外，其余用例工具都能执行。这些 hook 命令是 `echo`/`printf`/`exit`，瞬时且确定，无 flakiness。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/loop.test.ts`
Expected: FAIL（hooks 未接入 execCall）

- [ ] **Step 3: 写最小实现**

`src/loop.ts` 顶部 import 加：
```ts
import { runHooks, type HooksConfig } from './hooks.js'
```

`LoopDeps` 接口加字段（在 `injectTaskNotifications?` 后）：
```ts
  /** hooks 生命周期配置（会话启动快照）。仅主会话传入；子代理/webfetch 内部 loop 不传（①a）。 */
  hooks?: HooksConfig
```

替换 `execCall`（`src/loop.ts:58-86`）为：
```ts
async function execCall(call: ToolCall, deps: LoopDeps): Promise<{ ok: boolean; content: string; ms: number }> {
  const tool = deps.tools.find(t => t.name === call.name)
  if (!tool) {
    return { ok: false, content: `错误：工具 ${call.name} 不存在。可用工具：${deps.tools.map(t => t.name).join(', ')}`, ms: 0 }
  }
  let raw: unknown
  try { raw = JSON.parse(call.args || '{}') } catch {
    return { ok: false, content: '错误：参数不是合法 JSON。请重新发起本次工具调用，确保 arguments 是完整 JSON 对象。', ms: 0 }
  }
  const parsed = tool.inputSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; ')
    return { ok: false, content: `错误：参数不符合 schema：${issues}`, ms: 0 }
  }
  let input = parsed.data
  const cwd = deps.ctx.cwd()

  // —— PreToolUse hook（权限检查前）——
  let preAllow = false
  if (deps.hooks) {
    const descMaybe = tool.needsPermission(input)
    const pre = await runHooks('PreToolUse', {
      hook_event_name: 'PreToolUse', cwd, tool_name: tool.name, tool_input: input,
      tool_desc: typeof descMaybe === 'string' ? descMaybe : '',
    }, deps.hooks)
    if (pre.block) return { ok: false, content: `PreToolUse hook 阻止本次调用：${pre.blockReason ?? ''}`, ms: 0 }
    if (pre.updatedInput !== undefined) {
      const re = tool.inputSchema.safeParse(pre.updatedInput)
      if (!re.success) return { ok: false, content: 'PreToolUse hook 的 updatedInput 不符合工具 schema，已拒绝执行。', ms: 0 }
      input = re.data
    }
    preAllow = pre.permission === 'allow'
  }

  if (!preAllow) {
    const perm = await checkPermission(tool, input, deps.permission)
    if (!perm.ok) return { ok: false, content: perm.reason, ms: 0 }
  }

  const t0 = Date.now()
  try {
    let content = await tool.call(input, deps.ctx)
    if (deps.hooks) {
      const post = await runHooks('PostToolUse', {
        hook_event_name: 'PostToolUse', cwd, tool_name: tool.name, tool_input: input, tool_output: content,
      }, deps.hooks)
      if (post.updatedOutput !== undefined) content = post.updatedOutput
      if (post.additionalContext) content += `\n\n<hook-context>\n${post.additionalContext}\n</hook-context>`
    }
    return { ok: true, content, ms: Date.now() - t0 }
  } catch (e: any) {
    let content = `错误：${e?.message ?? String(e)}`
    if (deps.hooks) {
      const fail = await runHooks('PostToolUseFailure', {
        hook_event_name: 'PostToolUseFailure', cwd, tool_name: tool.name, tool_input: input, error: content,
      }, deps.hooks)
      if (fail.additionalContext) content += `\n\n<hook-context>\n${fail.additionalContext}\n</hook-context>`
    }
    return { ok: false, content, ms: Date.now() - t0 }
  }
}
```

> 注：`runHooks` 在 `deps.hooks` 为 undefined 时根本不被调用；即便调用，未配置事件也零开销。对未配置 hooks 的现有会话**行为完全不变**（现有 loop.test.ts 应继续全绿）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/loop.test.ts`
Expected: PASS（新 6 例 + 现有用例不回归）

- [ ] **Step 5: 提交**

```bash
git add src/loop.ts test/loop.test.ts
git commit -m "feat(loop): execCall 接入 PreToolUse/PostToolUse/PostToolUseFailure (L-042 ①a)"
```

---

### Task 8: 主会话接线（useChat + headless 传 hooks）

**Files:**
- Modify: `src/tui/useChat.ts:382-400`（deps 加 hooks）
- Modify: `src/headless.ts:51`（runLoop deps 加 hooks）

- [ ] **Step 1: 改 useChat.ts**

在 `deps: LoopDeps = { ... }` 对象里（`injectTaskNotifications: true,` 后）加：
```ts
        hooks: settings.hooks,
```

- [ ] **Step 2: 改 headless.ts**

`headless.ts:28` 已有 `const settings = loadSettings()`。在 `runLoop(messages, { ... })` 的 deps 对象里加：
```ts
    hooks: settings.hooks,
```
（若该处未解构 settings，确认 `settings.hooks` 可访问；否则 `loadSettings().hooks`。）

- [ ] **Step 3: 全量闸门**

Run:
```bash
npm test && npm run typecheck && npm run build
```
Expected: 全绿（含新 hooks.test / config.test / loop.test；现有 389+ 用例不回归）

- [ ] **Step 4: 提交**

```bash
git add src/tui/useChat.ts src/headless.ts
git commit -m "feat(hooks): 主会话(useChat/headless)接线传 settings.hooks (L-042 ①a)"
```

---

## 完成判据（①a）

- `src/hooks.ts` 引擎：5 纯函数 + runHooks + command 执行器，全单测覆盖。
- 配置：`Settings.hooks` + `parseHooksConfig` 宽松解析。
- `execCall` 接入 PreToolUse（deny/改写/allow）、PostToolUse（updatedOutput/additionalContext）、PostToolUseFailure。
- 主会话接线；webfetch 内部 loop 与子代理**不**接（①b 处理子代理）。
- 全量 `npm test`+`typecheck`+`build` 全绿；未配置 hooks 的会话行为零变化。
- 纯逻辑、不碰 TUI → **免真机冒烟**。
- 本架构地基件：每任务 implementer + 规格审 + 质量审；**末加 opus 全量终审**后合 main。

## 后续（不在本计划）
①b 其余 18 事件 dispatch（含子代理 SubagentStart/Stop、SessionStart 环境文件、Stop 续跑）→ ①c prompt/agent/http 类型 → ①d async/asyncRewake（挂 tasks.ts）→ ①e TUI 进度（碰 TUI 需冒烟）。
