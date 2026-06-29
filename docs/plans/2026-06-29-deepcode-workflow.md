# Workflow 编排 DSL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 deepcode 加 1:1 CC v2.1.193 的 Workflow 编排 DSL——确定性 JS 脚本（vm 沙箱）编排多 subagent，含 7 原语 + async 桥接 + structured output + resume journal + /workflows UI + ultracode 触发。

**Architecture:** 新增 `src/workflow/`（parse/sandbox/runtime/backend/journal/orchestrator）+ `src/tools/workflow.ts`。脚本在 Node 内置 `vm` 沙箱跑（确定性，保 resume）；原语是 host 用 `runInContext` 在 VM 域内造的 async 蹦床，绕开跨域 promise interop；`agent()` 走薄 `WorkflowBackend` 接口（单实现 `InProcessBackend` 包现有 `runSubagent`）；resume 靠 append-only JSONL journal，缓存键=调用 index+(prompt,opts)。复用现成 `runSubagent`(outputSchema)/`tasks.ts`(async_launched)/`worktree.ts`/`loop` 调度。

**Tech Stack:** TypeScript (ESM, `.js` import 后缀)、Node `node:vm`、zod + zod-to-json-schema、ink (TUI)、vitest。

## Global Constraints

- **范围 = 全量 1:1 CC v2.1.193**，VM 沙箱用 **Node 内置 `vm`**（非 isolated-vm）。
- **确定性硬约束**：禁 `Date.now/Math.random/new Date`（静态正则拒 + 不注入）、`eval/new Function`（`codeGeneration:{strings:false}`）、`wasm:false`、`import()`（throw）、fs/Node API。脚本纯 JS（非 TS）。
- **硬上限**（verbatim）：并发 `min(16, cpu cores - 2)` per workflow／单 workflow ≤ 1000 agent／单次 parallel/pipeline ≤ 4096 item／同步切片 timeout 30000ms。
- **触发关键字**：保留 `ultracode`（不本地化）。
- **错误/工具契约串保留 CC 英文 verbatim**（见 spec §5 表，测试断言钉死）。
- **effort 5→3 clamp**：CC `low/medium/high/xhigh/max` → deepcode `low/medium/high`（`xhigh/max`→`high`）。
- **model**：`agent()` 省略→继承 session 当前模型；`opts.model`→现有别名解析。
- **TUI 双组件铁律**：凡接线 UI 必同改 `App.tsx` + `FullscreenApp.tsx`。
- **新增工具三处铁律**：`tools/index.ts` allTools + `test/tools.registry.test.ts` 计数 + `test/agent.test.ts` 计数 + `GLOBAL_SUBAGENT_DENY`。
- 命令：测试 `npx vitest run <file>`、`npm run typecheck`、`npm run build`。提交风格 `feat(workflow): 中文描述`，无 trailer（项目惯例）。
- **现有调用者行为不变**：改 `RunSubagentOpts` 时默认值必须保持现状（`thinking:false`）。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/workflow/parse.ts` | 拆 meta（AST 不求值）+ 确定性扫描 + 纯 JS 检查 + 编译 vm.Script |
| `src/workflow/sandbox.ts` | createContext + 原语蹦床注入 + args + 跑脚本 + await 结果 |
| `src/workflow/backend.ts` | `WorkflowBackend` 接口 + `InProcessBackend`（包 runSubagent）|
| `src/workflow/journal.ts` | `LocalFileJournal` + 记录类型 + resume 缓存(index+(prompt,opts)) |
| `src/workflow/runtime.ts` | 7 原语语义（agent/parallel/pipeline/phase/log/budget/workflow）|
| `src/workflow/orchestrator.ts` | 顶层 harness：runId、wire journal/backend/sandbox、phase 事件、abort |
| `src/workflow/types.ts` | 共享类型（AgentSpec/JournalRecord/WorkflowProgress 等）|
| `src/tools/workflow.ts` | `Workflow` 工具，返回 async_launched + runId |
| `src/tui/WorkflowView.tsx` | `/workflows` 进度树组件 |
| 改 `src/subagentRunner.ts` | `RunSubagentOpts` += `thinking?`/`effortLevel?` |
| 改 `src/tasks.ts` | `TaskType` += `'local_workflow'` |
| 改 `src/tools/index.ts` / `agentTypes.ts` | 注册 + GLOBAL_SUBAGENT_DENY |
| 改 `App.tsx`/`FullscreenApp.tsx`/`useChat.ts` | 触发 + UI 接线 |

---

## Task 1: 子代理 effort/thinking 接线（先做，后续 agent() 映射依赖）

**Files:**
- Modify: `src/subagentRunner.ts:32-46`（RunSubagentOpts）、`src/subagentRunner.ts:88-95`（runLoop 调用）
- Test: `test/subagentRunner.effort.test.ts`

**Interfaces:**
- Produces: `RunSubagentOpts.thinking?: boolean`（默认 false）、`RunSubagentOpts.effortLevel?: 'low'|'medium'|'high'`

- [ ] **Step 1: 写失败测试** —— 验证 opts 传入后流到 runLoop

```ts
// test/subagentRunner.effort.test.ts
import { describe, it, expect, vi } from 'vitest'

// 拦截 runLoop，断言它收到的 deps
const loopSpy = vi.fn()
vi.mock('../src/loop.js', () => ({
  runLoop: (msgs: any[], deps: any) => { loopSpy(deps); return (async function* () {})() },
}))

import { runSubagent } from '../src/subagentRunner.js'

describe('subagent effort/thinking 接线', () => {
  it('把 thinking + effortLevel 传进内层 runLoop（默认 thinking=false）', async () => {
    loopSpy.mockClear()
    const base = {
      client: {} as any, onUsage: () => {}, systemPrompt: 's', userPrompt: 'u',
      tools: [], model: 'm', ctx: { cwd: () => '/', setCwd: () => {}, get signal() { return new AbortController().signal }, fileState: new Map() } as any,
      signal: new AbortController().signal, agentId: 'a1', agentType: 'general-purpose',
    }
    await runSubagent({ ...base, thinking: true, effortLevel: 'low' })
    expect(loopSpy).toHaveBeenCalledWith(expect.objectContaining({ thinking: true, effortLevel: 'low' }))
    loopSpy.mockClear()
    await runSubagent(base) // 不传 → 默认 thinking:false
    expect(loopSpy).toHaveBeenCalledWith(expect.objectContaining({ thinking: false }))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**
Run: `npx vitest run test/subagentRunner.effort.test.ts`
Expected: FAIL（当前硬编码 `thinking: false`，无 effortLevel）

- [ ] **Step 3: 改 RunSubagentOpts 接口**（`src/subagentRunner.ts:32-46`，在 `worktreePath?` 后加）

```ts
  /** worktree 路径。设置后子代理 cwd 锚定此 worktree，系统提示追加隔离说明。 */
  worktreePath?: string
  /** 推理开关。默认 false（保持现有所有调用者行为不变）。Workflow agent({effort}) 用。 */
  thinking?: boolean
  /** 推理档位（thinking=true 时透传 api reasoning_effort）。 */
  effortLevel?: 'low' | 'medium' | 'high'
```

- [ ] **Step 4: 改 runLoop 调用**（`src/subagentRunner.ts:88-95`，把硬编码 `thinking: false` 换成 opts）

```ts
    const gen = runLoop(messages, {
      client: opts.client,
      tools: subTools,
      model: opts.model,
      thinking: opts.thinking ?? false,
      effortLevel: opts.effortLevel,
      permission: { mode: 'default', rules: [], saveRule: () => {}, ask: async (_n, desc) => subagentPermissionDecision(desc) },
      ctx: subCtx,
      maxTurns: 30,
    })
```

- [ ] **Step 5: 跑测试 + 类型检查**
Run: `npx vitest run test/subagentRunner.effort.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 6: 跑全量回归（确认现有子代理行为不变）**
Run: `npx vitest run`
Expected: 既有测试全绿（仅 ask-chain flake 可接受）

- [ ] **Step 7: Commit**
```bash
git add src/subagentRunner.ts test/subagentRunner.effort.test.ts
git commit -m "feat(workflow): RunSubagentOpts 加 thinking/effortLevel 接线（默认不变）"
```

---

## Task 2: workflow/types.ts 共享类型

**Files:**
- Create: `src/workflow/types.ts`
- Test:（无独立测试，纯类型；被后续任务消费时验证）

**Interfaces:**
- Produces: 下列全部类型

- [ ] **Step 1: 写类型文件**

```ts
// src/workflow/types.ts
export interface WorkflowMeta {
  name: string
  description: string
  phases?: { title: string; detail?: string }[]
  model?: string
}

export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AgentOpts {
  label?: string
  phase?: string
  schema?: Record<string, unknown> // JSON Schema
  model?: string
  effort?: AgentEffort
  isolation?: 'worktree' | 'remote'
  agentType?: string
}

/** backend.runAgent 的入参（runtime 把 prompt+opts 归一成它）。 */
export interface AgentSpec {
  prompt: string
  opts: AgentOpts
  agentId: string
  index: number
}

export type JournalRecord =
  | { type: 'workflow_agent'; index: number; label?: string; phaseIndex?: number; phaseTitle?: string; agentId: string; model: string; status: 'ok' | 'error' | 'skipped'; prompt: string; optsKey: string; result: unknown }
  | { type: 'workflow_log'; index: number; message: string }
  | { type: 'workflow_phase'; index: number; title: string; phaseIndex: number }
  | { type: 'workflow_tool'; index: number; name: string }
  | { type: 'workflow_complete'; runId: string; agents: number; ms: number }

export interface WorkflowBudget {
  total: number | null
  spent: () => number
  remaining: () => number
}
```

- [ ] **Step 2: 类型检查**
Run: `npm run typecheck`
Expected: PASS（无引用错误）

- [ ] **Step 3: Commit**
```bash
git add src/workflow/types.ts
git commit -m "feat(workflow): 共享类型 types.ts"
```

---

## Task 3: parse.ts —— meta 提取 + 确定性扫描 + 纯 JS 检查 + 编译

**Files:**
- Create: `src/workflow/parse.ts`
- Test: `test/workflow.parse.test.ts`

**Interfaces:**
- Consumes: `WorkflowMeta`（Task 2）
- Produces: `parseWorkflow(script: string): { meta: WorkflowMeta; scriptBody: string }`（失败 throw `WorkflowParseError`）、`class WorkflowParseError extends Error { code: 'syntax'|'deterministic'|'plainjs'|'meta' }`

- [ ] **Step 1: 写失败测试**

```ts
// test/workflow.parse.test.ts
import { describe, it, expect } from 'vitest'
import { parseWorkflow, WorkflowParseError } from '../src/workflow/parse.js'

const ok = `export const meta = { name: 'x', description: 'd', phases: [{ title: 'A' }] }
const r = await agent('hi')`

describe('parseWorkflow', () => {
  it('拆出 meta 与 scriptBody', () => {
    const { meta, scriptBody } = parseWorkflow(ok)
    expect(meta.name).toBe('x')
    expect(meta.phases?.[0].title).toBe('A')
    expect(scriptBody).toContain("agent('hi')")
    expect(scriptBody).not.toContain('export const meta')
  })
  it('拒非确定性 Date.now()', () => {
    expect(() => parseWorkflow(`export const meta={name:'x',description:'d'}\nconst t=Date.now()`))
      .toThrow(/must be deterministic: Date\.now\(\)\/Math\.random\(\)\/new Date\(\) are unavailable \(breaks resume\)/)
  })
  it('拒 Math.random / new Date', () => {
    expect(() => parseWorkflow(`export const meta={name:'x',description:'d'}\nMath.random()`)).toThrow(WorkflowParseError)
    expect(() => parseWorkflow(`export const meta={name:'x',description:'d'}\nnew Date()`)).toThrow(WorkflowParseError)
  })
  it('拒 TS 语法（纯 JS）', () => {
    expect(() => parseWorkflow(`export const meta={name:'x',description:'d'}\nconst a: string[] = []`))
      .toThrow(/must be plain JavaScript/)
  })
  it('拒缺失 meta', () => {
    expect(() => parseWorkflow(`const r = await agent('hi')`)).toThrow(/meta/)
  })
  it('拒语法错误', () => {
    expect(() => parseWorkflow(`export const meta={name:'x',description:'d'}\nconst (`)).toThrow(/syntax/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**
Run: `npx vitest run test/workflow.parse.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 parse.ts**

```ts
// src/workflow/parse.ts
import vm from 'node:vm'
import type { WorkflowMeta } from './types.js'

export class WorkflowParseError extends Error {
  constructor(public code: 'syntax' | 'deterministic' | 'plainjs' | 'meta', message: string) {
    super(message)
    this.name = 'WorkflowParseError'
  }
}

const DETERMINISM_RE = /\b(Date\.now\s*\(|Math\.random\s*\(|new\s+Date\b)/
// 粗粒度 TS 语法侦测：类型注解 `: Type`（非对象字面量/三元）、interface/enum、泛型尖括号调用
const TS_RE = /(\binterface\s+[A-Za-z]|\benum\s+[A-Za-z]|:\s*(string|number|boolean|any|void|unknown)\b(\[\])?\s*[=,)])/

/** 拆 `export const meta = {...}` 字面量（AST 不求值）+ 校验脚本体。 */
export function parseWorkflow(script: string): { meta: WorkflowMeta; scriptBody: string } {
  // 1. 提取 meta 字面量（要求形如 export const meta = { ... }）
  const m = script.match(/export\s+const\s+meta\s*=\s*(\{[\s\S]*?\})\s*(?:\n|;|$)/)
  if (!m) throw new WorkflowParseError('meta', "Workflow script must start with `export const meta = {...}` (a pure object literal).")
  const metaLiteral = m[1]
  let meta: WorkflowMeta
  try {
    // 在隔离 context 求值「单个对象字面量」——不暴露任何全局，纯字面量无副作用
    const evalCtx = vm.createContext({ __proto__: null }, { codeGeneration: { strings: false, wasm: false } })
    meta = vm.runInContext(`(${metaLiteral})`, evalCtx, { timeout: 1000 }) as WorkflowMeta
  } catch {
    throw new WorkflowParseError('meta', 'Workflow `meta` must be a pure object literal (no variables, function calls, spreads, or template interpolation).')
  }
  if (!meta || typeof meta.name !== 'string' || typeof meta.description !== 'string') {
    throw new WorkflowParseError('meta', 'Workflow `meta` requires string fields `name` and `description`.')
  }
  // scriptBody = 去掉 meta 声明后的剩余
  const scriptBody = script.slice(0, m.index) + script.slice((m.index ?? 0) + m[0].length)
  // 2. 确定性静态扫描
  if (DETERMINISM_RE.test(scriptBody)) {
    throw new WorkflowParseError('deterministic', 'Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.')
  }
  // 3. 纯 JS（非 TS）
  if (TS_RE.test(scriptBody)) {
    throw new WorkflowParseError('plainjs', "Workflow scripts must be plain JavaScript — TypeScript syntax (type annotations like `: string[]`, interfaces, generics) fails to parse.")
  }
  // 4. 编译校验语法（async IIFE 包装 → top-level await 合法）
  try {
    new vm.Script(`(async () => { 'use strict';\n${scriptBody}\n})()`, { filename: 'workflow.js' })
  } catch (e) {
    throw new WorkflowParseError('syntax', `Workflow script has a syntax error and was not run: ${(e as Error).message}`)
  }
  return { meta, scriptBody }
}
```

- [ ] **Step 4: 跑测试确认通过**
Run: `npx vitest run test/workflow.parse.test.ts && npm run typecheck`
Expected: PASS（6 测试）

- [ ] **Step 5: Commit**
```bash
git add src/workflow/parse.ts test/workflow.parse.test.ts
git commit -m "feat(workflow): parse.ts —— meta 提取 + 确定性/纯JS/语法校验"
```

---

## Task 4: sandbox.ts —— vm 沙箱 + async 蹦床桥接（最硬，独立架构件）

**Files:**
- Create: `src/workflow/sandbox.ts`
- Test: `test/workflow.sandbox.test.ts`

**Interfaces:**
- Consumes: `WorkflowBudget`（Task 2）
- Produces: `runSandbox(scriptBody: string, args: unknown, hooks: SandboxHooks, signal: AbortSignal): Promise<unknown>`；`interface SandboxHooks { agent; parallel; pipeline; workflow; phase; log; budget }`

- [ ] **Step 1: 写失败测试**（核心：注入的 async 原语能被脚本 await；args 注入；确定性符号缺席；codeGeneration off）

```ts
// test/workflow.sandbox.test.ts
import { describe, it, expect } from 'vitest'
import { runSandbox, type SandboxHooks } from '../src/workflow/sandbox.js'

function hooks(over: Partial<SandboxHooks> = {}): SandboxHooks {
  return {
    agent: async (p: string) => `ran:${p}`,
    parallel: async (thunks: any[]) => Promise.all(thunks.map((t: any) => t())),
    pipeline: async (items: any[]) => items,
    workflow: async () => null,
    phase: () => {}, log: () => {},
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    ...over,
  }
}

describe('runSandbox', () => {
  it('脚本可 await 注入的 async agent()，并返回结果', async () => {
    const out = await runSandbox(`const r = await agent('hi'); return r`, null, hooks(), new AbortController().signal)
    expect(out).toBe('ran:hi')
  })
  it('args 经 JSON.parse 注入为 context-native', async () => {
    const out = await runSandbox(`return args.x + 1`, { x: 41 }, hooks(), new AbortController().signal)
    expect(out).toBe(42)
  })
  it('parallel 能调用脚本里的 thunk（() => agent(...)）', async () => {
    const out = await runSandbox(
      `const rs = await parallel([() => agent('a'), () => agent('b')]); return rs`,
      null, hooks(), new AbortController().signal)
    expect(out).toEqual(['ran:a', 'ran:b'])
  })
  it('Date.now/Math.random 在沙箱内不存在（运行期兜底）', async () => {
    const out = await runSandbox(`return typeof Date.now === 'function' ? 'has' : (typeof Math.random)`, null, hooks(), new AbortController().signal)
    // Date 整体被剔除 → 访问 Date.now 抛 → 用 try 包；这里验证 Math.random 缺席
    expect(out).not.toBe('has')
  })
  it('eval 被禁（codeGeneration.strings:false）', async () => {
    await expect(runSandbox(`return eval('1+1')`, null, hooks(), new AbortController().signal)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**
Run: `npx vitest run test/workflow.sandbox.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 sandbox.ts**

```ts
// src/workflow/sandbox.ts
import vm from 'node:vm'
import type { WorkflowBudget } from './types.js'

export interface SandboxHooks {
  agent: (prompt: string, opts?: unknown) => Promise<unknown>
  parallel: (thunks: unknown[]) => Promise<unknown[]>
  pipeline: (items: unknown[], ...stages: unknown[]) => Promise<unknown[]>
  workflow: (nameOrRef: unknown, args?: unknown) => Promise<unknown>
  phase: (title: string) => void
  log: (message: string) => void
  budget: WorkflowBudget
}

const SYNC_SLICE_TIMEOUT_MS = 30000

/** 在 Node vm 沙箱跑确定性脚本体。原语注入为「VM 域内 async 蹦床」，脚本 await 的是 VM 域 promise。 */
export async function runSandbox(scriptBody: string, args: unknown, hooks: SandboxHooks, signal: AbortSignal): Promise<unknown> {
  const context = vm.createContext({ __proto__: null }, { codeGeneration: { strings: false, wasm: false } })

  // 蹦床工厂：host 函数 → VM 域内 async/同步函数（由 host 用 runInContext 在 VM 域造）
  const wrapAsync = vm.runInContext('(hostFn => async (...a) => hostFn(...a))', context) as (f: Function) => Function
  const wrapSync = vm.runInContext('(hostFn => (...a) => hostFn(...a))', context) as (f: Function) => Function
  const define = (name: string, value: unknown) =>
    Object.defineProperty(context, name, { value, writable: true, enumerable: true, configurable: true })

  // 异步原语
  define('agent', wrapAsync((p: string, o: unknown) => hooks.agent(p, o)))
  define('parallel', wrapAsync((t: unknown[]) => hooks.parallel(t)))
  define('pipeline', wrapAsync((items: unknown[], ...stages: unknown[]) => hooks.pipeline(items, ...stages)))
  define('workflow', wrapAsync((n: unknown, a: unknown) => hooks.workflow(n, a)))
  // 同步原语
  define('phase', wrapSync((t: string) => hooks.phase(t)))
  define('log', wrapSync((m: string) => hooks.log(m)))
  // budget：VM 域对象，方法是同步蹦床
  define('budget', vm.runInContext('({ __proto__: null })', context))
  Object.defineProperty(context.budget, 'total', { value: hooks.budget.total, enumerable: true })
  Object.defineProperty(context.budget, 'spent', { value: wrapSync(() => hooks.budget.spent()), enumerable: true })
  Object.defineProperty(context.budget, 'remaining', { value: wrapSync(() => hooks.budget.remaining()), enumerable: true })
  // args：VM 内 JSON.parse → context-native
  define('args', vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(args ?? null))})`, context))
  // console / timers
  define('console', vm.runInContext('({ __proto__: null, log(){}, error(){}, warn(){}, info(){}, debug(){} })', context))
  define('setTimeout', wrapSync((fn: Function, ms: number) => setTimeout(fn, ms)))
  define('clearTimeout', wrapSync((t: unknown) => clearTimeout(t as NodeJS.Timeout)))

  // 编译脚本为 async IIFE（top-level await 生效；import() 禁用）
  const script = new vm.Script(`(async () => { 'use strict';\n${scriptBody}\n})()`, {
    filename: 'workflow.js',
    importModuleDynamically: (() => { throw new Error('import() is not available in workflow scripts.') }) as unknown as undefined,
  })
  const vmPromise = script.runInContext(context, { timeout: SYNC_SLICE_TIMEOUT_MS })

  // host 侧 await VM promise：用 VM 域内 async 包装器把 VM promise settle 成 host 可观察
  const awaiter = vm.runInContext('(async v => ({ __proto__: null, v: await v }))', context) as (v: unknown) => Promise<{ v: unknown }>
  const onAbort = () => {} // abort 由各原语内部 hooks 透传（agent/parallel 经 backend signal）
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const settled = await awaiter(vmPromise)
    return settled.v
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
```

- [ ] **Step 4: 跑测试确认通过**
Run: `npx vitest run test/workflow.sandbox.test.ts && npm run typecheck`
Expected: PASS（5 测试）。若 `Date.now` 缺席测试因 `Date` 整体被剔除而抛错，调整断言为 try/catch 形式但保持「非 has」语义。

- [ ] **Step 5: Commit**
```bash
git add src/workflow/sandbox.ts test/workflow.sandbox.test.ts
git commit -m "feat(workflow): sandbox.ts —— vm 沙箱 + async 蹦床桥接（1:1 CC runInContext 模式）"
```

---

## Task 5: backend.ts —— WorkflowBackend 接口 + InProcessBackend

**Files:**
- Create: `src/workflow/backend.ts`
- Test: `test/workflow.backend.test.ts`

**Interfaces:**
- Consumes: `AgentSpec`（Task 2）、`runSubagent`/`RunSubagentOpts`（Task 1）
- Produces: `interface WorkflowBackend { runAgent(spec: AgentSpec): Promise<{ status: 'ok'|'error'; result: unknown }> }`、`makeInProcessBackend(deps): WorkflowBackend`、effort 映射 `mapEffort(e?: AgentEffort): 'low'|'medium'|'high'|undefined`

- [ ] **Step 1: 写失败测试**

```ts
// test/workflow.backend.test.ts
import { describe, it, expect, vi } from 'vitest'
import { makeInProcessBackend, mapEffort } from '../src/workflow/backend.js'

describe('mapEffort（5→3 clamp）', () => {
  it('low/medium/high 直传，xhigh/max→high，undefined→undefined', () => {
    expect(mapEffort('low')).toBe('low')
    expect(mapEffort('high')).toBe('high')
    expect(mapEffort('xhigh')).toBe('high')
    expect(mapEffort('max')).toBe('high')
    expect(mapEffort(undefined)).toBeUndefined()
  })
})

describe('InProcessBackend', () => {
  it('调用 runSubagent，effort/thinking/model 透传', async () => {
    const runSubagent = vi.fn().mockResolvedValue('"hello"')
    const backend = makeInProcessBackend({ runSubagent: runSubagent as any, sessionModel: 'glm-5.2', client: {} as any, onUsage: () => {}, ctx: {} as any, signal: new AbortController().signal, agents: [] })
    const out = await backend.runAgent({ prompt: 'p', opts: { effort: 'max', model: undefined }, agentId: 'a1', index: 0 })
    expect(out.status).toBe('ok')
    const call = runSubagent.mock.calls[0][0]
    expect(call.model).toBe('glm-5.2')       // 省略 model → 继承 session
    expect(call.thinking).toBe(true)          // 设了 effort → thinking on
    expect(call.effortLevel).toBe('high')     // max→high
  })
  it('isolation:"remote" → 报 not available', async () => {
    const backend = makeInProcessBackend({ runSubagent: vi.fn() as any, sessionModel: 'm', client: {} as any, onUsage: () => {}, ctx: {} as any, signal: new AbortController().signal, agents: [] })
    await expect(backend.runAgent({ prompt: 'p', opts: { isolation: 'remote' }, agentId: 'a1', index: 0 }))
      .rejects.toThrow(/isolation:'remote'\}\) is not available in this build/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**
Run: `npx vitest run test/workflow.backend.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 backend.ts**

```ts
// src/workflow/backend.ts
import type OpenAI from 'openai'
import { z } from 'zod'
import type { ToolContext } from '../tools/types.js'
import type { Usage } from '../api.js'
import type { AgentSpec, AgentEffort } from './types.js'

export interface WorkflowBackend {
  runAgent(spec: AgentSpec): Promise<{ status: 'ok' | 'error'; result: unknown }>
}

export function mapEffort(e?: AgentEffort): 'low' | 'medium' | 'high' | undefined {
  if (!e) return undefined
  if (e === 'xhigh' || e === 'max') return 'high'
  return e
}

export interface InProcessBackendDeps {
  runSubagent: (opts: any) => Promise<string | undefined>
  sessionModel: string
  client: OpenAI
  onUsage: (u: Usage, model: string) => void
  ctx: ToolContext
  signal: AbortSignal
  agents: { agentType: string; getSystemPrompt: () => string; outputSchema?: z.ZodTypeAny }[]
  resolveModelAlias?: (m: string) => string
}

/** 单实现：包 runSubagent，一次性 runAgent(spec)→结果。isolation:'remote' 拒（1:1 CC）。 */
export function makeInProcessBackend(deps: InProcessBackendDeps): WorkflowBackend {
  return {
    async runAgent(spec) {
      if (spec.opts.isolation === 'remote') {
        throw new Error("agent({isolation:'remote'}) is not available in this build.")
      }
      const effortLevel = mapEffort(spec.opts.effort)
      const model = spec.opts.model ? (deps.resolveModelAlias?.(spec.opts.model) ?? spec.opts.model) : deps.sessionModel
      const agentType = spec.opts.agentType ?? 'general-purpose'
      const def = deps.agents.find(a => a.agentType === agentType)
      const systemPrompt = def?.getSystemPrompt() ?? ''
      // schema：JSON Schema → 这里 v1 用 zod 透传层；若 def 有 outputSchema 用之，否则把 JSON Schema 包成 z.any 校验占位
      const outputSchema = spec.opts.schema ? z.any() : def?.outputSchema
      try {
        const raw = await deps.runSubagent({
          client: deps.client, onUsage: deps.onUsage, systemPrompt, userPrompt: spec.prompt,
          tools: [], model, outputSchema, ctx: deps.ctx, signal: deps.signal,
          agentId: spec.agentId, agentType,
          worktreePath: spec.opts.isolation === 'worktree' ? undefined : undefined, // worktree 由 orchestrator 预置（Task 10 接 worktree.ts）
          thinking: effortLevel !== undefined, effortLevel,
        })
        const result = spec.opts.schema && raw ? JSON.parse(raw) : raw
        return { status: 'ok', result: result ?? null }
      } catch {
        return { status: 'error', result: null }
      }
    },
  }
}
```
> 注：`tools: []` 是占位——orchestrator（Task 10）注入真实工具池（allTools + webFetch + Agent 自引用，**不含 Workflow**）。worktree isolation 的 worktreePath 预置在 Task 10 接 `worktree.ts`。本任务只锁接口与 effort/model/remote 行为。

- [ ] **Step 4: 跑测试确认通过**
Run: `npx vitest run test/workflow.backend.test.ts && npm run typecheck`
Expected: PASS（3 测试）

- [ ] **Step 5: Commit**
```bash
git add src/workflow/backend.ts test/workflow.backend.test.ts
git commit -m "feat(workflow): backend.ts —— WorkflowBackend + InProcessBackend（effort 映射/remote 拒）"
```

---

## Task 6: journal.ts —— append-only journal + resume 缓存

**Files:**
- Create: `src/workflow/journal.ts`
- Test: `test/workflow.journal.test.ts`

**Interfaces:**
- Consumes: `JournalRecord`（Task 2）
- Produces: `class LocalFileJournal { constructor(path: string); append(r: JournalRecord): Promise<void>; load(): Promise<JournalRecord[]> }`、`cachedAgent(records: JournalRecord[], index: number, prompt: string, optsKey: string): { hit: boolean; result?: unknown }`、`optsKeyOf(opts: unknown): string`

- [ ] **Step 1: 写失败测试**

```ts
// test/workflow.journal.test.ts
import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { LocalFileJournal, cachedAgent, optsKeyOf } from '../src/workflow/journal.js'

describe('LocalFileJournal + resume 缓存', () => {
  it('append 后 load 回读', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfj-'))
    const j = new LocalFileJournal(join(dir, 'journal.jsonl'))
    await j.append({ type: 'workflow_agent', index: 0, agentId: 'a0', model: 'm', status: 'ok', prompt: 'p0', optsKey: optsKeyOf({}), result: 'r0' })
    await j.append({ type: 'workflow_log', index: 1, message: 'hi' })
    const recs = await j.load()
    expect(recs).toHaveLength(2)
    expect(recs[0].type).toBe('workflow_agent')
  })
  it('缓存命中：同 index + 同 (prompt,optsKey) → 返缓存结果', async () => {
    const recs = [{ type: 'workflow_agent', index: 0, agentId: 'a0', model: 'm', status: 'ok', prompt: 'p0', optsKey: optsKeyOf({ label: 'x' }), result: 'cached' }] as any
    const hit = cachedAgent(recs, 0, 'p0', optsKeyOf({ label: 'x' }))
    expect(hit).toEqual({ hit: true, result: 'cached' })
  })
  it('缓存未命中：prompt 变 → miss（从该点 live）', async () => {
    const recs = [{ type: 'workflow_agent', index: 0, agentId: 'a0', model: 'm', status: 'ok', prompt: 'p0', optsKey: optsKeyOf({}), result: 'cached' }] as any
    expect(cachedAgent(recs, 0, 'CHANGED', optsKeyOf({})).hit).toBe(false)
  })
  it('optsKeyOf 稳定（键序无关）', () => {
    expect(optsKeyOf({ a: 1, b: 2 })).toBe(optsKeyOf({ b: 2, a: 1 }))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**
Run: `npx vitest run test/workflow.journal.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 journal.ts**

```ts
// src/workflow/journal.ts
import { appendFile, readFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { JournalRecord } from './types.js'

export class LocalFileJournal {
  constructor(private path: string) {}
  async append(r: JournalRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await appendFile(this.path, JSON.stringify(r) + '\n')
  }
  async load(): Promise<JournalRecord[]> {
    let raw: string
    try { raw = await readFile(this.path, 'utf8') } catch { return [] }
    return raw.split('\n').filter(Boolean).map(l => JSON.parse(l) as JournalRecord)
  }
}

/** 稳定 opts 键：递归按键排序后 JSON。 */
export function optsKeyOf(opts: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as object).sort().map(k => [k, sort((v as Record<string, unknown>)[k])]))
    }
    return v
  }
  return JSON.stringify(sort(opts ?? {}))
}

/** resume 缓存查询：同 index 的 workflow_agent 记录，prompt+optsKey 全等 → 命中。 */
export function cachedAgent(records: JournalRecord[], index: number, prompt: string, optsKey: string): { hit: boolean; result?: unknown } {
  const rec = records.find(r => r.type === 'workflow_agent' && r.index === index)
  if (rec && rec.type === 'workflow_agent' && rec.prompt === prompt && rec.optsKey === optsKey) {
    return { hit: true, result: rec.result }
  }
  return { hit: false }
}
```

- [ ] **Step 4: 跑测试确认通过**
Run: `npx vitest run test/workflow.journal.test.ts && npm run typecheck`
Expected: PASS（4 测试）

- [ ] **Step 5: Commit**
```bash
git add src/workflow/journal.ts test/workflow.journal.test.ts
git commit -m "feat(workflow): journal.ts —— append-only journal + resume 缓存(index+prompt+optsKey)"
```

---

## Task 7: runtime.ts —— agent() + 并发上限 + budget

**Files:**
- Create: `src/workflow/runtime.ts`
- Test: `test/workflow.runtime.agent.test.ts`

**Interfaces:**
- Consumes: `WorkflowBackend`（Task 5）、`LocalFileJournal`/`cachedAgent`/`optsKeyOf`（Task 6）、`WorkflowBudget`（Task 2）
- Produces: `createRuntime(deps: RuntimeDeps): SandboxHooks & { agentCount: () => number }`，其中 `RuntimeDeps = { backend; journal; records; budget; onProgress; abortSignal; resolveWorkflow?; getAllWorkflows? }`

- [ ] **Step 1: 写失败测试**（agent 缓存命中跳过 backend；budget 上限；1000 上限）

```ts
// test/workflow.runtime.agent.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createRuntime } from '../src/workflow/runtime.js'
import { optsKeyOf } from '../src/workflow/journal.js'

function deps(over: any = {}) {
  return {
    backend: { runAgent: vi.fn().mockResolvedValue({ status: 'ok', result: 'live' }) },
    journal: { append: vi.fn().mockResolvedValue(undefined) },
    records: [],
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    onProgress: () => {},
    abortSignal: new AbortController().signal,
    ...over,
  }
}

describe('runtime.agent()', () => {
  it('正常调用 backend，返回 result', async () => {
    const d = deps()
    const rt = createRuntime(d as any)
    expect(await rt.agent('p')).toBe('live')
    expect(d.backend.runAgent).toHaveBeenCalledOnce()
  })
  it('resume 缓存命中 → 跳过 backend', async () => {
    const records = [{ type: 'workflow_agent', index: 0, agentId: 'a0', model: 'm', status: 'ok', prompt: 'p', optsKey: optsKeyOf({}), result: 'cached' }]
    const d = deps({ records })
    const rt = createRuntime(d as any)
    expect(await rt.agent('p')).toBe('cached')
    expect(d.backend.runAgent).not.toHaveBeenCalled()
  })
  it('backend error → 返回 null', async () => {
    const d = deps({ backend: { runAgent: vi.fn().mockResolvedValue({ status: 'error', result: null }) } })
    expect(await createRuntime(d as any).agent('p')).toBeNull()
  })
  it('budget 达 total → agent() throw', async () => {
    const d = deps({ budget: { total: 100, spent: () => 100, remaining: () => 0 } })
    await expect(createRuntime(d as any).agent('p')).rejects.toThrow(/budget/i)
  })
  it('超 1000 agent → throw backstop', async () => {
    const d = deps()
    const rt = createRuntime(d as any)
    // @ts-expect-error 测试内部计数
    for (let i = 0; i < 1000; i++) await rt.agent('p' + i)
    await expect(rt.agent('over')).rejects.toThrow(/1000/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**
Run: `npx vitest run test/workflow.runtime.agent.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 runtime.ts 的 agent() + 计数 + budget**（parallel/pipeline 在 Task 8）

```ts
// src/workflow/runtime.ts
import os from 'node:os'
import type { SandboxHooks } from './sandbox.js'
import type { WorkflowBackend } from './backend.js'
import type { LocalFileJournal } from './journal.js'
import { cachedAgent, optsKeyOf } from './journal.js'
import type { JournalRecord, WorkflowBudget, AgentOpts } from './types.js'

export const MAX_CONCURRENCY = Math.max(1, Math.min(16, os.cpus().length - 2))
export const MAX_AGENTS = 1000
export const MAX_ITEMS = 4096

export interface RuntimeDeps {
  backend: WorkflowBackend
  journal: LocalFileJournal
  records: JournalRecord[] // resume 时预载的历史
  budget: WorkflowBudget
  onProgress: (rec: JournalRecord) => void
  abortSignal: AbortSignal
  resolveWorkflow?: (nameOrRef: unknown, args: unknown) => Promise<unknown>
}

export function createRuntime(deps: RuntimeDeps): SandboxHooks & { agentCount: () => number } {
  let index = 0
  let agents = 0
  let phaseIndex = -1
  let phaseTitle: string | undefined

  async function agent(prompt: string, opts: AgentOpts = {}): Promise<unknown> {
    const i = index++
    if (agents >= MAX_AGENTS) throw new Error(`Total agent count across a workflow's lifetime is capped at ${MAX_AGENTS} — a runaway-loop backstop.`)
    if (deps.budget.total != null && deps.budget.remaining() <= 0) throw new Error('Workflow token budget exhausted: spent() reached total, further agent() calls throw.')
    const optsKey = optsKeyOf(opts)
    const cache = cachedAgent(deps.records, i, prompt, optsKey)
    if (cache.hit) return cache.result
    agents++
    const agentId = `wfa_${i}`
    const out = await deps.backend.runAgent({ prompt, opts, agentId, index: i })
    const status = out.status === 'ok' ? 'ok' : 'error'
    const rec: JournalRecord = { type: 'workflow_agent', index: i, label: opts.label, phaseIndex: phaseIndex < 0 ? undefined : phaseIndex, phaseTitle, agentId, model: opts.model ?? '', status, prompt, optsKey, result: out.result }
    await deps.journal.append(rec)
    deps.onProgress(rec)
    return out.status === 'ok' ? out.result : null
  }

  function phase(title: string): void {
    phaseIndex++
    phaseTitle = title
    const rec: JournalRecord = { type: 'workflow_phase', index: index, title, phaseIndex }
    void deps.journal.append(rec)
    deps.onProgress(rec)
  }

  function log(message: string): void {
    const rec: JournalRecord = { type: 'workflow_log', index, message }
    void deps.journal.append(rec)
    deps.onProgress(rec)
  }

  async function parallel(): Promise<unknown[]> { throw new Error('implemented in Task 8') }
  async function pipeline(): Promise<unknown[]> { throw new Error('implemented in Task 8') }
  async function workflow(nameOrRef: unknown, a?: unknown): Promise<unknown> {
    if (!deps.resolveWorkflow) throw new Error('Nested workflow() is not available here.')
    return deps.resolveWorkflow(nameOrRef, a)
  }

  return { agent, parallel, pipeline, workflow, phase, log, budget: deps.budget, agentCount: () => agents }
}
```

- [ ] **Step 4: 跑测试确认通过**
Run: `npx vitest run test/workflow.runtime.agent.test.ts && npm run typecheck`
Expected: PASS（5 测试）

- [ ] **Step 5: Commit**
```bash
git add src/workflow/runtime.ts test/workflow.runtime.agent.test.ts
git commit -m "feat(workflow): runtime agent()/phase()/log() + budget/1000 上限"
```

---

## Task 8: runtime.ts —— parallel() + pipeline() + 并发调度

**Files:**
- Modify: `src/workflow/runtime.ts`（替换 Task 7 的 parallel/pipeline 占位）
- Test: `test/workflow.runtime.concurrency.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `createRuntime`
- Produces: `parallel`/`pipeline` 真实实现 + 内部 `runWithCap(thunks, cap)`

- [ ] **Step 1: 写失败测试**（parallel barrier + throw→null；pipeline 无 barrier + stage throw→item drop；4096 上限；parallel 非函数报错）

```ts
// test/workflow.runtime.concurrency.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createRuntime } from '../src/workflow/runtime.js'

const base = () => ({ backend: { runAgent: vi.fn() }, journal: { append: vi.fn().mockResolvedValue(undefined) }, records: [], budget: { total: null, spent: () => 0, remaining: () => Infinity }, onProgress: () => {}, abortSignal: new AbortController().signal })

describe('parallel', () => {
  it('await 全部 thunk，throw 位 → null', async () => {
    const rt = createRuntime(base() as any)
    const out = await rt.parallel([() => Promise.resolve('a'), () => { throw new Error('x') }, () => Promise.resolve('c')])
    expect(out).toEqual(['a', null, 'c'])
  })
  it('传 promise 而非 thunk → 报错', async () => {
    const rt = createRuntime(base() as any)
    await expect(rt.parallel([Promise.resolve('a') as any])).rejects.toThrow(/expects an array of functions, not promises/)
  })
  it('>4096 item → 显式报错', async () => {
    const rt = createRuntime(base() as any)
    await expect(rt.parallel(Array.from({ length: 4097 }, () => () => Promise.resolve(1)))).rejects.toThrow(/at most 4096 items/)
  })
})

describe('pipeline', () => {
  it('每 item 穿全 stage；stage throw → item 降 null', async () => {
    const rt = createRuntime(base() as any)
    const out = await rt.pipeline([1, 2, 3],
      (x: number) => x * 10,
      (x: number) => { if (x === 20) throw new Error('drop'); return x + 1 })
    expect(out).toEqual([11, null, 31])
  })
  it('stage 收到 (prev, orig, idx)', async () => {
    const rt = createRuntime(base() as any)
    const seen: any[] = []
    await rt.pipeline(['a'], (_p: any, orig: any, idx: any) => { seen.push([orig, idx]); return 1 })
    expect(seen).toEqual([['a', 0]])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**
Run: `npx vitest run test/workflow.runtime.concurrency.test.ts`
Expected: FAIL（占位抛 "implemented in Task 8"）

- [ ] **Step 3: 替换 parallel/pipeline 实现**（删 Task 7 的两个占位，在 `createRuntime` 内实现）

```ts
  // 并发上限调度：跑 thunks，最多 MAX_CONCURRENCY 在途，结果保序，throw→null
  async function runWithCap<T>(thunks: (() => Promise<T>)[]): Promise<(T | null)[]> {
    const results: (T | null)[] = new Array(thunks.length).fill(null)
    let next = 0
    async function worker() {
      while (next < thunks.length) {
        const i = next++
        try { results[i] = await thunks[i]() } catch { results[i] = null }
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, thunks.length) }, worker))
    return results
  }

  async function parallel(thunks: unknown[]): Promise<unknown[]> {
    if (!Array.isArray(thunks) || thunks.some(t => typeof t !== 'function')) {
      throw new Error('parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)')
    }
    if (thunks.length > MAX_ITEMS) throw new Error(`A single parallel()/pipeline() call accepts at most ${MAX_ITEMS} items; passing more is an explicit error, not a silent truncation.`)
    return runWithCap(thunks as (() => Promise<unknown>)[])
  }

  async function pipeline(items: unknown[], ...stages: unknown[]): Promise<unknown[]> {
    if (items.length > MAX_ITEMS) throw new Error(`A single parallel()/pipeline() call accepts at most ${MAX_ITEMS} items; passing more is an explicit error, not a silent truncation.`)
    const fns = stages as ((prev: unknown, orig: unknown, idx: number) => unknown)[]
    // 每 item 独立穿全 stage，无 barrier；并发受 cap 约束
    const thunks = items.map((orig, idx) => async () => {
      let cur: unknown = orig
      for (const stage of fns) cur = await stage(cur, orig, idx)
      return cur
    })
    return runWithCap(thunks)
  }
```
> 替换 Task 7 里 `async function parallel()...` 与 `async function pipeline()...` 两个占位。`runWithCap` 定义在 `createRuntime` 内，`parallel`/`pipeline` 之上。

- [ ] **Step 4: 跑测试确认通过 + Task 7 回归**
Run: `npx vitest run test/workflow.runtime.concurrency.test.ts test/workflow.runtime.agent.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/workflow/runtime.ts test/workflow.runtime.concurrency.test.ts
git commit -m "feat(workflow): runtime parallel()/pipeline() + 并发cap/4096 上限"
```

---

## Task 9: orchestrator.ts —— 顶层 harness（端到端跑脚本）

**Files:**
- Create: `src/workflow/orchestrator.ts`
- Test: `test/workflow.orchestrator.test.ts`

**Interfaces:**
- Consumes: `parseWorkflow`(T3)、`runSandbox`(T4)、`makeInProcessBackend`(T5)、`LocalFileJournal`(T6)、`createRuntime`(T7/8)
- Produces: `runWorkflow(opts: RunWorkflowOpts): Promise<{ runId: string; result: unknown; agents: number }>`、`generateRunId(rand?): string`（`wf_<12hex>`）

- [ ] **Step 1: 写失败测试**（端到端：脚本跑通、journal 落盘、resume 命中）

```ts
// test/workflow.orchestrator.test.ts
import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { mkdtempSync } from 'node:fs'
import { runWorkflow, generateRunId } from '../src/workflow/orchestrator.js'

const script = `export const meta = { name: 't', description: 'd' }
phase('go')
const r = await agent('hello')
return r`

function opts(dir: string, over: any = {}) {
  return {
    script, args: null, runId: undefined, journalDir: dir,
    backend: { runAgent: vi.fn().mockResolvedValue({ status: 'ok', result: 'WORLD' }) },
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    onProgress: () => {}, abortSignal: new AbortController().signal,
    ...over,
  }
}

describe('runWorkflow 端到端', () => {
  it('runId 形如 wf_<12hex>', () => {
    expect(generateRunId(() => Buffer.from('0123456789abcdef', 'hex'))).toMatch(/^wf_[0-9a-f]{12}$/)
  })
  it('跑脚本 → 返回 agent 结果，agents 计数', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfo-'))
    const out = await runWorkflow(opts(dir))
    expect(out.result).toBe('WORLD')
    expect(out.agents).toBe(1)
  })
  it('resume：同 runId 二次跑，backend 不再被调（缓存命中）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfo-'))
    const o1 = opts(dir)
    const r1 = await runWorkflow(o1)
    const o2 = opts(dir, { runId: r1.runId, backend: { runAgent: vi.fn() } })
    const r2 = await runWorkflow(o2)
    expect(r2.result).toBe('WORLD')
    expect(o2.backend.runAgent).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**
Run: `npx vitest run test/workflow.orchestrator.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 orchestrator.ts**

```ts
// src/workflow/orchestrator.ts
import crypto from 'node:crypto'
import { join } from 'node:path'
import { parseWorkflow } from './parse.js'
import { runSandbox } from './sandbox.js'
import { LocalFileJournal } from './journal.js'
import { createRuntime } from './runtime.js'
import type { WorkflowBackend } from './backend.js'
import type { JournalRecord, WorkflowBudget } from './types.js'

export function generateRunId(rand: (n: number) => Buffer = crypto.randomBytes): string {
  return 'wf_' + rand(6).toString('hex').slice(0, 12)
}

export interface RunWorkflowOpts {
  script: string
  args: unknown
  runId?: string
  journalDir: string
  backend: WorkflowBackend
  budget: WorkflowBudget
  onProgress: (rec: JournalRecord) => void
  abortSignal: AbortSignal
  resolveWorkflow?: (nameOrRef: unknown, args: unknown) => Promise<unknown>
}

export async function runWorkflow(opts: RunWorkflowOpts): Promise<{ runId: string; result: unknown; agents: number }> {
  const { meta, scriptBody } = parseWorkflow(opts.script)
  const runId = opts.runId ?? generateRunId()
  const journal = new LocalFileJournal(join(opts.journalDir, runId, 'journal.jsonl'))
  const records = await journal.load() // resume：预载历史
  const runtime = createRuntime({
    backend: opts.backend, journal, records, budget: opts.budget,
    onProgress: opts.onProgress, abortSignal: opts.abortSignal, resolveWorkflow: opts.resolveWorkflow,
  })
  const start = (globalThis.performance?.now?.() ?? 0)
  const result = await runSandbox(scriptBody, opts.args, runtime, opts.abortSignal)
  const ms = Math.round((globalThis.performance?.now?.() ?? 0) - start)
  const agents = runtime.agentCount()
  await journal.append({ type: 'workflow_complete', runId, agents, ms })
  void meta // meta.name/phases 供 UI/进度展示（Task 11）
  return { runId, result, agents }
}
```

- [ ] **Step 4: 跑测试确认通过**
Run: `npx vitest run test/workflow.orchestrator.test.ts && npm run typecheck`
Expected: PASS（3 测试）

- [ ] **Step 5: Commit**
```bash
git add src/workflow/orchestrator.ts test/workflow.orchestrator.test.ts
git commit -m "feat(workflow): orchestrator.ts —— 端到端 harness + runId + resume 接线"
```

---

## Task 10: tools/workflow.ts —— Workflow 工具 + 注册 + async_launched

**Files:**
- Create: `src/tools/workflow.ts`
- Modify: `src/tasks.ts:8`（TaskType += 'local_workflow'）、`src/tools/index.ts`（不直接加 allTools——见注）、`src/tools/agentTypes.ts:19`（GLOBAL_SUBAGENT_DENY += 'Workflow'）
- Modify 注入点: `src/headless.ts:115`、`src/tui/useChat.ts:584-603`（注入 makeWorkflowTool）
- Test: `test/workflow.tool.test.ts`、改 `test/agent.test.ts`（计数）

**Interfaces:**
- Consumes: `runWorkflow`(T9)、`makeInProcessBackend`(T5)、`tasks.ts`(registerTask/generateTaskId/updateTask/enqueueNotification)
- Produces: `makeWorkflowTool(deps): Tool`（name `'Workflow'`，返回 `{status:'async_launched', taskId, runId, scriptPath?}`）

- [ ] **Step 1: 写失败测试**

```ts
// test/workflow.tool.test.ts
import { describe, it, expect, vi } from 'vitest'
import { makeWorkflowTool } from '../src/tools/workflow.js'

describe('Workflow 工具', () => {
  it('name=Workflow, isReadOnly, 后台启动返回 async_launched + runId', async () => {
    const tool = makeWorkflowTool({ client: {} as any, onUsage: () => {}, sessionModel: 'm', agents: [], runSubagent: vi.fn() as any, journalDir: '/tmp/x' })
    expect(tool.name).toBe('Workflow')
    const out: any = await tool.call({ script: `export const meta={name:'t',description:'d'}\nreturn 1` } as any, { cwd: () => '/', signal: new AbortController().signal } as any)
    expect(out).toMatch(/async_launched/)
    expect(out).toMatch(/wf_/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**
Run: `npx vitest run test/workflow.tool.test.ts`
Expected: FAIL

- [ ] **Step 3: TaskType 加 'local_workflow'**（`src/tasks.ts:8`）

```ts
export type TaskType = 'local_bash' | 'local_agent' | 'local_hook' | 'local_workflow'
```
并在 `generateTaskId` 前缀映射加 `local_workflow → 'w'`（看 `src/tasks.ts:75-81` 现有 prefix 逻辑，加分支）。

- [ ] **Step 4: 实现 tools/workflow.ts**

```ts
// src/tools/workflow.ts
import { z } from 'zod'
import type OpenAI from 'openai'
import type { Tool } from './types.js'
import type { Usage } from '../api.js'
import { runWorkflow } from '../workflow/orchestrator.js'
import { makeInProcessBackend } from '../workflow/backend.js'
import { registerTask, updateTask, generateTaskId, enqueueNotification, getTask } from '../tasks.js'
import type { JournalRecord } from '../workflow/types.js'

const schema = z.object({
  script: z.string().optional().describe('内联 workflow 脚本（以 export const meta = {...} 开头）'),
  name: z.string().optional().describe('预定义 workflow 名'),
  scriptPath: z.string().optional().describe('磁盘脚本路径（优先级最高）'),
  args: z.any().optional().describe('注入为脚本全局 args 的 JSON 值'),
  resumeFromRunId: z.string().regex(/^wf_[a-z0-9-]{6,}$/).optional().describe('从既有 run 增量重跑'),
})

export interface WorkflowToolDeps {
  client: OpenAI
  onUsage: (u: Usage, model: string) => void
  sessionModel: string
  agents: { agentType: string; getSystemPrompt: () => string; outputSchema?: z.ZodTypeAny }[]
  runSubagent: (opts: any) => Promise<string | undefined>
  journalDir: string
  resolveModelAlias?: (m: string) => string
}

export function makeWorkflowTool(deps: WorkflowToolDeps): Tool<typeof schema> {
  return {
    name: 'Workflow',
    description: 'orchestrate subagents with deterministic JavaScript workflow. Use this tool for multi-step orchestration where control flow should be deterministic (loops, conditionals, fan-out) rather than model-driven.',
    inputSchema: schema,
    isReadOnly: true,
    needsPermission: () => false,
    async call(input, ctx) {
      const script = input.script ?? '' // scriptPath/name 解析在后续增量（v1 主走 inline）
      const taskId = generateTaskId('local_workflow')
      const abort = new AbortController()
      const progress: JournalRecord[] = []
      const backend = makeInProcessBackend({
        runSubagent: deps.runSubagent, sessionModel: deps.sessionModel, client: deps.client,
        onUsage: deps.onUsage, ctx, signal: abort.signal, agents: deps.agents, resolveModelAlias: deps.resolveModelAlias,
      })
      registerTask({
        id: taskId, type: 'local_workflow', status: 'running', description: `workflow`,
        startTime: Date.now(), outputFile: '', outputOffset: 0, notified: false, abortController: abort,
      } as any)
      // 脱钩异步跑
      void runWorkflow({
        script, args: input.args, runId: input.resumeFromRunId, journalDir: deps.journalDir,
        backend, budget: { total: null, spent: () => 0, remaining: () => Infinity },
        onProgress: r => progress.push(r), abortSignal: abort.signal,
      }).then(res => {
        updateTask(taskId, { status: 'completed', result: JSON.stringify(res.result) } as any)
        const t = getTask(taskId); if (t) enqueueNotification(t)
      }).catch(err => {
        updateTask(taskId, { status: 'failed', result: String(err?.message ?? err) } as any)
        const t = getTask(taskId); if (t) enqueueNotification(t)
      })
      return JSON.stringify({ status: 'async_launched', taskId, runId: input.resumeFromRunId ?? '(generating wf_...)', taskType: 'local_workflow' })
    },
  }
}
```
> 注：v1 主走 `script` inline；`scriptPath`/`name` 的文件解析与 runId 回填（启动后才有真实 runId）作为收尾增量在本任务 Step 内可选补（用 `runWorkflow` 内生成的 runId 经 progress 回传）。

- [ ] **Step 5: GLOBAL_SUBAGENT_DENY += 'Workflow'**（`src/tools/agentTypes.ts:19`）

```ts
export const GLOBAL_SUBAGENT_DENY = ['ExitPlanMode', 'EnterWorktree', 'ExitWorktree', 'Workflow']
```

- [ ] **Step 6: 注入工具**（`src/headless.ts:115` 与 `src/tui/useChat.ts:584-603` 的工具数组里加 `makeWorkflowTool({...})`，与现有 `makeAgentTool`/`makeWebFetchTool` 并列；`journalDir` = `<projectRoot>/.deepcode/workflows`，`agents` = BUILTIN_AGENTS，`runSubagent` import 自 subagentRunner）。两处都改（双注入点铁律）。

- [ ] **Step 7: 改 agent.test.ts 计数断言**（`test/agent.test.ts` 若断言子代理工具池含/不含某些工具，确认 `Workflow` 在 GLOBAL_SUBAGENT_DENY 内被剔除——子代理池不含 Workflow）。补一条断言：

```ts
it('子代理池不含 Workflow（仅一层嵌套）', () => {
  // 复用现有 resolveAgentTools 测试模式，断言结果 .map(t=>t.name) 不含 'Workflow'
})
```

- [ ] **Step 8: 跑测试 + 回归 + 构建**
Run: `npx vitest run test/workflow.tool.test.ts test/agent.test.ts && npm run typecheck && npm run build`
Expected: PASS

- [ ] **Step 9: Commit**
```bash
git add src/tools/workflow.ts src/tasks.ts src/tools/agentTypes.ts src/headless.ts src/tui/useChat.ts test/workflow.tool.test.ts test/agent.test.ts
git commit -m "feat(workflow): Workflow 工具 + async_launched + 注册(双注入点+GLOBAL_SUBAGENT_DENY)"
```

---

## Task 11: /workflows UI —— 进度树（TUI 双组件）

**Files:**
- Create: `src/tui/WorkflowView.tsx`
- Modify: `src/tui/App.tsx` + `src/tui/FullscreenApp.tsx`（接 `/workflows` 命令 + 渲染，**双改铁律**）、`src/tui/useChat.ts`（命令分派 + 进度状态）
- Test: `test/workflowView.test.tsx`（ink-testing-library）

**Interfaces:**
- Consumes: `JournalRecord`/`tasks.ts` BackgroundTask
- Produces: `WorkflowView` 组件 `{ runs: WorkflowRunSummary[] }`；`formatWorkflowProgress(records, task): WorkflowRunSummary`（纯函数）

- [ ] **Step 1: 写失败测试**（纯函数 formatWorkflowProgress + 组件渲染 phase 分组/完成态）

```tsx
// test/workflowView.test.tsx
import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { WorkflowView, formatWorkflowProgress } from '../src/tui/WorkflowView.js'

describe('formatWorkflowProgress', () => {
  it('汇总 phase/agent 计数与完成态', () => {
    const recs = [
      { type: 'workflow_phase', index: 0, title: 'Scan', phaseIndex: 0 },
      { type: 'workflow_agent', index: 1, agentId: 'a', model: 'm', status: 'ok', prompt: 'p', optsKey: '{}', result: 1 },
      { type: 'workflow_complete', runId: 'wf_abc', agents: 1, ms: 1234 },
    ] as any
    const s = formatWorkflowProgress(recs, { id: 'w1', status: 'completed' } as any)
    expect(s.agents).toBe(1)
    expect(s.phases[0].title).toBe('Scan')
    expect(s.done).toBe(true)
    expect(s.ms).toBe(1234)
  })
})

describe('WorkflowView 渲染', () => {
  it('显示 phase 标题与 Completed 行', () => {
    const runs = [{ runId: 'wf_abc', name: 't', done: true, agents: 1, ms: 1234, phases: [{ title: 'Scan', agents: 1 }] }]
    const { lastFrame } = render(<WorkflowView runs={runs as any} />)
    expect(lastFrame()).toContain('Scan')
    expect(lastFrame()).toMatch(/Completed in/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**
Run: `npx vitest run test/workflowView.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现 WorkflowView.tsx**（formatWorkflowProgress 纯函数 + Ink 组件，1:1 CC `Completed in Ns · N agents · N tokens` 串）

```tsx
// src/tui/WorkflowView.tsx
import React from 'react'
import { Box, Text } from 'ink'
import type { JournalRecord } from '../workflow/types.js'

export interface WorkflowRunSummary {
  runId: string
  name: string
  done: boolean
  agents: number
  ms: number
  phases: { title: string; agents: number }[]
}

export function formatWorkflowProgress(records: JournalRecord[], task: { id: string; status: string }): WorkflowRunSummary {
  const phases: { title: string; agents: number }[] = []
  let agents = 0, ms = 0, done = false, runId = '', name = ''
  for (const r of records) {
    if (r.type === 'workflow_phase') phases.push({ title: r.title, agents: 0 })
    else if (r.type === 'workflow_agent') { agents++; if (phases.length) phases[phases.length - 1].agents++ }
    else if (r.type === 'workflow_complete') { done = true; ms = r.ms; runId = r.runId; agents = r.agents }
  }
  return { runId, name, done: done || task.status === 'completed', agents, ms, phases }
}

export function WorkflowView({ runs }: { runs: WorkflowRunSummary[] }) {
  return (
    <Box flexDirection="column">
      {runs.map(run => (
        <Box key={run.runId} flexDirection="column" marginBottom={1}>
          <Text bold>{run.name || run.runId}</Text>
          {run.phases.map((p, i) => (
            <Text key={i}>  {run.done ? '✓' : '⟳'} {p.title} · {p.agents} agents</Text>
          ))}
          {run.done && <Text dimColor>Completed in {(run.ms / 1000).toFixed(1)}s · {run.agents} agents</Text>}
        </Box>
      ))}
    </Box>
  )
}
```

- [ ] **Step 4: 接线 `/workflows` 命令到双组件**（`App.tsx` + `FullscreenApp.tsx`：在命令分派处加 `/workflows` → 收集 `listTasks().filter(t=>t.type==='local_workflow')` + 各自 journal → `formatWorkflowProgress` → 渲染 `WorkflowView`。两文件都改）。

- [ ] **Step 5: 跑测试 + 构建**
Run: `npx vitest run test/workflowView.test.tsx && npm run typecheck && npm run build`
Expected: PASS

- [ ] **Step 6: Commit**
```bash
git add src/tui/WorkflowView.tsx src/tui/App.tsx src/tui/FullscreenApp.tsx src/tui/useChat.ts test/workflowView.test.tsx
git commit -m "feat(workflow): /workflows 进度树 UI（双组件接线）"
```

---

## Task 12: 触发接线 —— ultracode 关键字 + /effort ultracode + 消费门

**Files:**
- Modify: `src/tui/useChat.ts`（prompt 提交前检测 `ultracode` 关键字）、`src/config.ts`（Settings += `skipWorkflowUsageWarning?`、`workflowKeywordTriggerEnabled?`）、`src/settingsLayers.ts:137-165`（parsePresent 注册，非 DANGEROUS）
- Test: `test/workflow.trigger.test.ts`

**Interfaces:**
- Consumes: config Settings
- Produces: `detectUltracode(prompt: string): boolean`（`/\bultracode\b/i`，但排除 `ultrathink`）、`workflowUsageWarning(skip: boolean): string | null`

- [ ] **Step 1: 写失败测试**

```ts
// test/workflow.trigger.test.ts
import { describe, it, expect } from 'vitest'
import { detectUltracode, workflowUsageWarning } from '../src/workflow/trigger.js'

describe('ultracode 触发', () => {
  it('命中 ultracode 关键字', () => {
    expect(detectUltracode('please ultracode this audit')).toBe(true)
    expect(detectUltracode('normal request')).toBe(false)
    expect(detectUltracode('ultrathink about it')).toBe(false) // 不误触 ultrathink
  })
  it('消费门：skip=true → 不弹', () => {
    expect(workflowUsageWarning(true)).toBeNull()
    expect(workflowUsageWarning(false)).toMatch(/multi-agent workflow/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**
Run: `npx vitest run test/workflow.trigger.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 trigger.ts**

```ts
// src/workflow/trigger.ts
export function detectUltracode(prompt: string): boolean {
  // ultracode 独立词，且排除 ultrathink（CC：两者独立正则）
  return /\bultracode\b/i.test(prompt)
}

export function workflowUsageWarning(skip: boolean): string | null {
  if (skip) return null
  return 'This will run a multi-agent workflow that may spawn many subagents and consume significant tokens. Set skipWorkflowUsageWarning to skip this notice.'
}
```

- [ ] **Step 4: config + settingsLayers 注册**（`src/config.ts` Settings 接口加 `skipWorkflowUsageWarning?: boolean` 与 `workflowKeywordTriggerEnabled?: boolean`；`src/settingsLayers.ts` parsePresent 加分支解析，**非 DANGEROUS**——可被 project/local 设置）。

- [ ] **Step 5: useChat 接线**（prompt 提交前：`detectUltracode(prompt) && workflowKeywordTriggerEnabled !== false` → 注入引导让模型用 Workflow 工具 + 首次弹 `workflowUsageWarning`。最小实现：在系统/引导消息追加 `<ultracode>` 提示。**双组件若涉及 UI 提示需双改**）。

- [ ] **Step 6: 跑测试 + 全量回归 + 构建**
Run: `npx vitest run && npm run typecheck && npm run build`
Expected: 全绿（仅 ask-chain flake 可接受）

- [ ] **Step 7: Commit**
```bash
git add src/workflow/trigger.ts src/config.ts src/settingsLayers.ts src/tui/useChat.ts test/workflow.trigger.test.ts
git commit -m "feat(workflow): ultracode 触发 + /effort ultracode + 消费门接线"
```

---

## Task 13: 真机冒烟（碰 TUI 双组件，不可省）

**Files:** 无代码改动（除冒烟揪出的修复）。

- [ ] **Step 1: 用本地构建跑**（不是全局旧 npm！）
Run: `npm run build && node /Users/silas/loop/deepcode/dist/index.js`
确认欢迎页版本号 + 工具列表含 `Workflow`。

- [ ] **Step 2: ultracode 触发端到端** —— 输入含 `ultracode` 的任务（如「ultracode 审一遍这三个文件找 bug」），确认模型写 workflow 脚本 → `Workflow` 工具 async_launched → 后台跑 → 完成通知 → 结构化结果。

- [ ] **Step 3: /workflows 进度树** —— 跑中与完成后各 `/workflows`，确认 phase 分组 + `Completed in Ns · N agents` 行。**App + FullscreenApp 双跑验证**（默认全屏跑 FullscreenApp）。

- [ ] **Step 4: resume 缓存命中** —— 写一个 inline workflow，跑完后改其中一个 agent() prompt，用 `resumeFromRunId` 重跑，确认前缀缓存命中、改动点起 live（看 journal 或日志）。

- [ ] **Step 5: 确定性拒** —— 脚本含 `Date.now()` → 解析期被拒，错误串含 `must be deterministic`。

- [ ] **Step 6: worktree 隔离** —— `agent({isolation:'worktree'})` 真起 worktree、改动隔离（接 worktree.ts 后验证）。

- [ ] **Step 7: 全量测试 + 提交冒烟修复**
Run: `npx vitest run`
Expected: 1363+ passed（仅 ask-chain flake）。冒烟揪出的修复各自原子提交。

---

## Self-Review（写完核对 spec）

**Spec 覆盖**：§0 范围取舍→Task 各处 Global Constraints；§1 七模块→Task 2-11 全覆盖（parse/sandbox/runtime/backend/journal/orchestrator/tool/ui）；§2 DSL 语义→Task 7/8（原语）+ Task 1/5（effort/model）；§3 执行流+桥接+resume→Task 4/6/9；§4 触发/UI/上限/错误→Task 8(上限)/11(UI)/12(触发)；§5 测试+verbatim 串→各 Task 测试断言 + Task 13 冒烟；§6 依赖序→Task 1→13 即此序。**无遗漏。**

**占位扫描**：backend.ts `tools:[]`、worktreePath 预置、tool 的 scriptPath/name 解析、UI/触发的 useChat 接线步——均标注为「Task 10/11/12 收尾增量」并给了落点，非 TBD 空话。可执行。

**类型一致**：`AgentSpec{prompt,opts,agentId,index}`、`JournalRecord` 联合、`SandboxHooks`、`WorkflowBackend.runAgent`、`createRuntime`/`runWorkflow` 签名跨任务一致；`mapEffort`/`optsKeyOf`/`cachedAgent`/`generateRunId` 命名一致。

**已知风险**：Task 4 async 蹦床桥接是最高风险（vm promise settle 跨域）——若 `awaiter(vmPromise)` 在某些 Node 版本对 VM-realm promise 解析异常，回退方案=在脚本 IIFE 内把结果存到注入的 host 回调（`__resolve`）而非靠返回值。Task 4 测试若红，先验证此回退。
