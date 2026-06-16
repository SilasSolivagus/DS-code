# L-042 Hooks ①b-1：核心控制流事件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 deepcode hooks 系统接入 7 类有**实质行为**的生命周期事件（Stop/StopFailure/SubagentStart/SubagentStop/UserPromptSubmit/PreCompact/PostCompact/PermissionRequest/PermissionDenied），引入统一的 `ToolContext.hookDispatch` 枢纽，并实现 Stop/SubagentStop 的「block→续跑」状态机（修 ①a 终审 I-1）。

**Architecture:** ①a 已落地引擎（`src/hooks.ts` 的 `runHooks`）和 PreToolUse/PostToolUse/PostToolUseFailure 接线。本件分三条注入路径接事件：①**loop.ts 内事件**（Stop/StopFailure/Permission*）用已有的 `LoopDeps.hooks` config；②**工具层事件**（SubagentStart/Stop）经新增的 `ToolContext.hookDispatch` 闭包（主会话 ctx 注入，子代理不注入）；③**useChat 自有事件**（UserPromptSubmit/PreCompact/PostCompact）在 `createChatCore` 内直接 `runHooks(settings.hooks)`。续跑用引擎层 `stopHookFired` 守卫硬防无限循环，dispatch 方读 `outcome.preventContinuation`/`outcome.stop` 而非语义重载的 `outcome.block`（对齐 CC query.ts:1267-1306：`decision:block`→注入 reason 续跑，`continue:false`→硬停）。

**Tech Stack:** TypeScript/ESM、vitest、Node child_process（command hook 走真 spawn 测）。

**对齐源：** CC 源码 `/Users/silas/Desktop/src`（query.ts:1267-1306 Stop 续跑状态机、utils/hooks.ts:518-535 continue/decision 区分、AskUserQuestion 无关）。两份实读对齐报告 + 接线地图已存于本会话上下文。

**once 决策（用户拍板）：** CC 的 `once:true` 仅对 skill/plugin frontmatter hooks 实现（registerSkillHooks.ts 的 `onHookSuccess`→`removeSessionHook`）。deepcode 尚无 skill hooks 系统，故本件**只保留 `once` 字段 + 注释，不消费**，待 L-022 skill 系统落地时按 CC 实现。

---

## File Structure

| 文件 | 改动 | 责任 |
|---|---|---|
| `src/tools/types.ts` | 改 | `ToolContext` 加 `hookDispatch?` 字段（hooks 枢纽） |
| `src/hooks.ts` | 改 | `HookCommon.once` 字段补注释（不消费说明） |
| `src/loop.ts` | 改 | runLoop 接 Stop（续跑+守卫）/StopFailure；execCall 接 PermissionRequest/PermissionDenied |
| `src/permissions.ts` | 改 | `checkPermission` 加可选 `PermissionHooks` 参数（ask 前/拒绝后钩子） |
| `src/tools/agent.ts` | 改 | runSub 接 SubagentStart（注入 context）/SubagentStop（续跑子循环） |
| `src/tui/useChat.ts` | 改 | ctx 注入 hookDispatch；runTurn 接 UserPromptSubmit；doCompact 接 Pre/PostCompact |
| `src/headless.ts` | 改 | ctx 注入 hookDispatch；prompt 提交前接 UserPromptSubmit |
| `test/loop.test.ts` | 改 | Stop/StopFailure/Permission* 集成测试 |
| `test/permissions.test.ts` | 改 | checkPermission 的 hook 分支单测 |
| `test/agent.test.ts` | 改 | SubagentStart/Stop 续跑测试 |
| `test/useChat.hooks.test.ts` | 建 | UserPromptSubmit/PreCompact/PostCompact（mock runHooks） |

**全程闸门：** 每个 Task 的 commit 步骤前必须 `npm test`+`npm run typecheck`+`npm run build` 全绿。纯逻辑，免真机冒烟。

---

## Task 1: ToolContext.hookDispatch 枢纽 + once 注释

**Files:**
- Modify: `src/tools/types.ts:1-17`
- Modify: `src/hooks.ts:20`
- Modify: `src/tui/useChat.ts:202-209`
- Modify: `src/headless.ts:32-38`

基础设施 task（纯类型扩展 + 接线），用 typecheck + 既有测试不破作为验证。

- [ ] **Step 1: `ToolContext` 加 hookDispatch 字段**

`src/tools/types.ts` 顶部 import 区加（与现有 import 并列）：

```typescript
import type { HookEvent, HookOutcome } from '../hooks.js'
```

在 `ToolContext` 接口末尾（`isSubagent?` 字段后）加：

```typescript
  /** hooks 生命周期分派闭包（捕获会话 hooks 快照）。主会话 ctx 注入；子代理/headless-headless 内部子 ctx 不注入。
   *  工具层事件（SubagentStart/Stop、①b-2 的 CwdChanged/Task*/Notification）经此发事件。对空配置零开销返回空 outcome。 */
  hookDispatch?: (event: HookEvent, payload: Record<string, unknown>) => Promise<HookOutcome>
```

- [ ] **Step 2: hooks.ts 的 once 字段补注释**

`src/hooks.ts:20` 的 `HookCommon` 接口，把 `once?: boolean` 这一项替换为带注释版本：

```typescript
interface HookCommon {
  timeout?: number
  if?: string
  /** 一次性 hook：CC 仅对 skill/plugin frontmatter hooks 实现（onHookSuccess→removeSessionHook）。
   *  deepcode 尚无 skill hooks 系统，故当前**保留字段不消费**，待 L-022 skill 系统落地按 CC 实现。 */
  once?: boolean
  statusMessage?: string
}
```

> 注意：原 `HookCommon` 是单行 `interface HookCommon { timeout?: number; if?: string; once?: boolean; statusMessage?: string }`，整体替换为上面多行版本。

- [ ] **Step 3: useChat ctx 注入 hookDispatch**

`src/tui/useChat.ts` 顶部**当前未 import `runHooks`**（已核实），在 import 区新增一行：

```typescript
import { runHooks } from '../hooks.js'
```

把 `src/tui/useChat.ts:202-209` 的 `ctx` 对象末尾（`recordBeforeImage` 行后）加一行：

```typescript
  const ctx: ToolContext = {
    cwd: () => cwd,
    setCwd: d => { cwd = d },
    get signal() { return abort.signal },
    fileState: new Map(),
    todos,
    recordBeforeImage: (absPath: string) => { if (currentTurnId > 0) checkpointer.capture(absPath, currentTurnId) },
    hookDispatch: (event, payload) => runHooks(event, payload, settings.hooks),
  }
```

- [ ] **Step 4: headless ctx 注入 hookDispatch**

`src/headless.ts` 顶部 import 区加：

```typescript
import { runHooks } from './hooks.js'
```

把 `src/headless.ts:32-38` 的 `ctx` 末尾（`todos,` 行后）加一行：

```typescript
  const ctx: ToolContext = {
    cwd: () => cwd,
    setCwd: d => { cwd = d },
    signal: new AbortController().signal,
    fileState: new Map(),
    todos,
    hookDispatch: (event, payload) => runHooks(event, payload, settings.hooks),
  }
```

- [ ] **Step 5: 验证 typecheck + 既有测试不破**

Run: `npm run typecheck && npm test`
Expected: typecheck 干净；全部既有测试通过（新字段是可选，无行为变化）。

- [ ] **Step 6: Commit**

```bash
git add src/tools/types.ts src/hooks.ts src/tui/useChat.ts src/headless.ts
git commit -m "feat(hooks): add ToolContext.hookDispatch hub + once field note (L-042 ①b-1)"
```

---

## Task 2: Stop hook 续跑 + stop_hook_active 守卫

**Files:**
- Modify: `src/loop.ts:123-186`（runLoop 函数体加 stopHookFired 变量 + return 'done' 前 dispatch）
- Test: `test/loop.test.ts`（新增 describe 'runLoop + Stop hook'）

- [ ] **Step 1: 写失败测试**

在 `test/loop.test.ts` 末尾（最后一个 describe 之后）追加：

```typescript
describe('runLoop + Stop hook', () => {
  it('Stop hook decision:block → 注入 reason 作 user 消息续跑一次', async () => {
    script.push(
      { result: { content: '先到这', toolCalls: [], usage, finishReason: 'stop' } },
      { result: { content: '续跑完成', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const deps = makeDeps([readTool])
    deps.hooks = { Stop: [{ hooks: [{ type: 'command', command: `printf '%s' '{"decision":"block","reason":"还有事没做"}'` }] }] }
    const messages: any[] = [{ role: 'user', content: 'go' }]
    const { ret } = await drain(runLoop(messages, deps))
    expect(ret).toBe('done')
    expect(messages.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('还有事没做'))).toBe(true)
  })

  it('Stop hook 反复 block → 守卫只续跑一次（防无限循环）', async () => {
    // 只放两幕：第一次 done→block→续跑（第二幕）→第二次 done 时 stopHookFired 已 true→不再续跑。
    // 若守卫失效会第三次 shift 空 script 抛 'script exhausted'。
    script.push(
      { result: { content: 'a', toolCalls: [], usage, finishReason: 'stop' } },
      { result: { content: 'b', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const deps = makeDeps([readTool])
    deps.hooks = { Stop: [{ hooks: [{ type: 'command', command: `printf '%s' '{"decision":"block","reason":"再来"}'` }] }] }
    const { ret } = await drain(runLoop([{ role: 'user', content: 'go' }], deps))
    expect(ret).toBe('done')
  })

  it('未配置 Stop hook → 正常 done，不续跑', async () => {
    script.push({ result: { content: '完成', toolCalls: [], usage, finishReason: 'stop' } })
    const { ret } = await drain(runLoop([{ role: 'user', content: 'go' }], makeDeps([readTool])))
    expect(ret).toBe('done')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/loop.test.ts -t "Stop hook"`
Expected: FAIL —— decision:block 不会续跑（当前 line 186 直接 `return 'done'`），第二幕未被消费、注入断言失败。

- [ ] **Step 3: 实现 Stop dispatch + 守卫**

`src/loop.ts` 的 `runLoop` 函数（line 123-126），在 `const apiTools = toApiTools(deps.tools)` 之后、`for (let turn...` 之前，新增续跑守卫变量：

```typescript
export async function* runLoop(
  messages: any[],
  deps: LoopDeps,
): AsyncGenerator<LoopEvent, 'done' | 'aborted' | 'max_turns'> {
  const apiTools = toApiTools(deps.tools)
  let stopHookFired = false // Stop hook block→续跑守卫：每次 runLoop 最多续跑一次，硬防无限循环
  for (let turn = 0; turn < (deps.maxTurns ?? 80); turn++) {
```

把 `src/loop.ts:186` 的 `return 'done'`（在 `if (!result.toolCalls.length) { ... }` 块内，injectTaskNotifications 段之后）替换为：

```typescript
      // Stop hook：即将自然结束前触发。对齐 CC（query.ts:1267-1306）——
      // preventContinuation（decision:block / exit2）→ 注入 blockReason 作 user 消息续跑（守卫限一次）；
      // 读 preventContinuation/stop 而非 block（block 在 permission 通道也为真，语义重载，见 ①a 终审 I-1）。
      if (deps.hooks) {
        const last = messages[messages.length - 1]
        const stop = await runHooks('Stop', {
          hook_event_name: 'Stop',
          cwd: deps.ctx.cwd(),
          stop_hook_active: stopHookFired,
          last_assistant_message: typeof last?.content === 'string' ? last.content : '',
        }, deps.hooks)
        if (stop.preventContinuation && !stopHookFired) {
          stopHookFired = true
          messages.push({ role: 'user', content: stop.blockReason ?? '（Stop hook 要求继续未尽事项）' })
          continue
        }
      }
      return 'done'
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/loop.test.ts -t "Stop hook"`
Expected: PASS（三例全过）。

- [ ] **Step 5: 全量 + commit**

```bash
npm test && npm run typecheck && npm run build
git add src/loop.ts test/loop.test.ts
git commit -m "feat(hooks): Stop hook block→continue with once-guard (L-042 ①b-1)"
```

---

## Task 3: StopFailure hook（API 异常）

**Files:**
- Modify: `src/loop.ts:150-156`（catch 分支 throw e 前 dispatch）
- Test: `test/loop.test.ts`

- [ ] **Step 1: 写失败测试**

在 `test/loop.test.ts` 顶部确认已 import `existsSync`（与现有 fs import 并列；若无则在 `import { mkdtempSync, writeFileSync } from 'node:fs'` 改为 `import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'`）。在 `describe('runLoop + Stop hook')` 之后追加：

```typescript
describe('runLoop + StopFailure hook', () => {
  it('API 抛错（非中断）→ StopFailure hook 触发后继续抛', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-sf-'))
    const flag = path.join(dir, 'fired.txt')
    // 不 push script → mock chatStream 抛 'script exhausted'，进 catch（signal 未 abort）
    const deps = makeDeps([readTool])
    deps.hooks = { StopFailure: [{ hooks: [{ type: 'command', command: `printf fired > ${flag}` }] }] }
    await expect(drain(runLoop([{ role: 'user', content: 'go' }], deps))).rejects.toThrow()
    expect(existsSync(flag)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/loop.test.ts -t "StopFailure"`
Expected: FAIL —— flag 文件未写（当前 catch 直接 `throw e`）。

- [ ] **Step 3: 实现 StopFailure dispatch**

`src/loop.ts:150-156` 的 catch 分支，把 `throw e` 替换为：

```typescript
    } catch (e) {
      if (deps.ctx.signal.aborted) {
        sealMessages(messages, '（本轮已被用户中断。）')
        return 'aborted'
      }
      // StopFailure hook：API 调用异常（非用户中断）。记录/通知用途，await 完成后继续抛（不改变控制流）。
      if (deps.hooks) {
        await runHooks('StopFailure', {
          hook_event_name: 'StopFailure',
          cwd: deps.ctx.cwd(),
          error: (e as any)?.message ?? String(e),
        }, deps.hooks)
      }
      throw e
    }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/loop.test.ts -t "StopFailure"`
Expected: PASS。

- [ ] **Step 5: 全量 + commit**

```bash
npm test && npm run typecheck && npm run build
git add src/loop.ts test/loop.test.ts
git commit -m "feat(hooks): StopFailure hook on API error (L-042 ①b-1)"
```

---

## Task 4: SubagentStart + SubagentStop（续跑子循环）

**Files:**
- Modify: `src/tools/agent.ts:63-135`（runSub 包裹 Start/Stop；前台/后台都传 agentId）
- Test: `test/agent.test.ts`

**设计：** `runSub` 改签名为 `runSub(signal, agentId)`。开头 dispatch **SubagentStart**（`additionalContext` 注入子代理 messages）；拿到 final 后 dispatch **SubagentStop**，`preventContinuation` 且未续跑过 → 注入 reason 重跑一轮子循环（守卫 `subStopFired` 限一次，与 Stop 同构）。用主会话 `ctx.hookDispatch`（子代理 ctx 不含 hookDispatch，故 dispatch 用外层 `ctx`）。agent_id：前台 `generateTaskId('local_agent')`（仅作 payload 标识，不注册 task），后台复用已生成的 `id`。

- [ ] **Step 1: 写失败测试**

在 `test/agent.test.ts` 的 `ctx` 工厂下方加一个可注入 hookDispatch 的工厂（在 `const ctx = (): any => ({...})` 之后）：

```typescript
const ctxWithHook = (dispatch: any): any => ({
  cwd: () => process.cwd(), setCwd: () => {}, signal: new AbortController().signal, fileState: new Map(),
  hookDispatch: dispatch,
})
const emptyOutcome = { block: false, preventContinuation: false, stop: false, results: [] }
```

在 `describe('Agent 子代理')` 内追加两个用例：

```typescript
  it('SubagentStart hook 的 additionalContext 注入子代理上下文', async () => {
    script.push({ result: { content: '已读到注入的上下文', toolCalls: [], usage, finishReason: 'stop' } })
    const seen: any[] = []
    const dispatch = vi.fn(async (event: string, _p: any) => {
      seen.push(event)
      if (event === 'SubagentStart') return { ...emptyOutcome, additionalContext: '注意：只看 src/' }
      return emptyOutcome
    })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: 'x', prompt: '查文件' }, ctxWithHook(dispatch))
    expect(out).toContain('已读到注入的上下文')
    expect(seen).toContain('SubagentStart')
    expect(seen).toContain('SubagentStop')
  })

  it('SubagentStop preventContinuation → 注入 reason 续跑子循环一次', async () => {
    // 两幕：第一次结束→SubagentStop block→续跑→第二次结束（守卫限一次）
    script.push(
      { result: { content: '第一版', toolCalls: [], usage, finishReason: 'stop' } },
      { result: { content: '修订版', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const dispatch = vi.fn(async (event: string, payload: any) => {
      if (event === 'SubagentStop' && payload.stop_hook_active === false) {
        return { ...emptyOutcome, preventContinuation: true, blockReason: '再核对一遍' }
      }
      return emptyOutcome
    })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: 'x', prompt: '审查' }, ctxWithHook(dispatch))
    expect(out).toContain('修订版')
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/agent.test.ts -t "Subagent"`
Expected: FAIL —— 当前 runSub 不 dispatch hooks；第二例第二幕未被消费（无续跑）→ out 是「第一版」。

- [ ] **Step 3: 实现 runSub 的 SubagentStart/Stop**

`src/tools/agent.ts`，把 `runSub` 定义（line 64-92）整体替换为接受 `agentId` 并包裹 hooks 的版本：

```typescript
      // 跑子代理子循环，返回最后一条 assistant 文本（前后台共用）。
      // SubagentStart：开头注入 additionalContext；SubagentStop：结束后 preventContinuation→续跑一轮（守卫限一次）。
      const runSub = async (signal: AbortSignal, agentId: string): Promise<string | undefined> => {
        const messages: any[] = [
          { role: 'system', content: def.getSystemPrompt() },
          { role: 'user', content: input.prompt },
        ]
        if (ctx.hookDispatch) {
          const startOut = await ctx.hookDispatch('SubagentStart', {
            hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: type, cwd: ctx.cwd(),
          })
          if (startOut.additionalContext) {
            messages.push({ role: 'user', content: `<hook-context>\n${startOut.additionalContext}\n</hook-context>` })
          }
        }
        const subCtx: ToolContext = {
          cwd: ctx.cwd,
          setCwd: () => { /* 子代理只读，不许漂移主 cwd */ },
          get signal() { return signal },
          fileState: new Map(),
          isSubagent: true, // 子代理纯执行：禁止起后台任务（防污染主会话通知队列）
        }
        let subStopFired = false
        while (true) {
          const gen = runLoop(messages, {
            client: deps.client,
            tools,
            model: subModel,
            thinking: false,
            permission: { mode: 'default', rules: [], saveRule: () => {}, ask: async (_n, desc) => subagentPermissionDecision(desc) },
            ctx: subCtx,
            maxTurns: 30,
          })
          let step
          while (!(step = await gen.next()).done) {
            if (step.value.type === 'turn_end') deps.onUsage(step.value.usage, subModel)
          }
          const final = [...messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content)
          if (ctx.hookDispatch && !signal.aborted) {
            const stopOut = await ctx.hookDispatch('SubagentStop', {
              hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: type, cwd: ctx.cwd(),
              stop_hook_active: subStopFired,
              last_assistant_message: final?.content ?? '',
            })
            if (stopOut.preventContinuation && !subStopFired) {
              subStopFired = true
              messages.push({ role: 'user', content: stopOut.blockReason ?? '（SubagentStop 要求继续未尽事项）' })
              continue
            }
          }
          return final?.content
        }
      }
```

把后台路径的 `const final = await runSub(ac.signal)`（line 109）改为传入已有 `id`：

```typescript
            const final = await runSub(ac.signal, id)
```

把前台路径（line 128-135）改为先生成 agentId 再调用：

```typescript
      // 前台路径（默认）：维持现有 acquire/try-finally-release。
      await acquire()
      try {
        const final = await runSub(ctx.signal, generateTaskId('local_agent'))
        return final ?? '（子代理无输出）'
      } finally {
        release()
      }
```

> `generateTaskId` 已在 agent.ts 顶部 import（line 14），直接复用；前台仅作 payload 标识，不 registerTask。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/agent.test.ts -t "Subagent"`
Expected: PASS（两例）。同时跑全 agent 测试确认无回归：`npx vitest run test/agent.test.ts`

- [ ] **Step 5: 全量 + commit**

```bash
npm test && npm run typecheck && npm run build
git add src/tools/agent.ts test/agent.test.ts
git commit -m "feat(hooks): SubagentStart context + SubagentStop continue loop (L-042 ①b-1)"
```

---

## Task 5: UserPromptSubmit hook（block / additionalContext）

**Files:**
- Modify: `src/tui/useChat.ts:347-378`（runTurn 开头 dispatch；block→拦截不发，additionalContext→注入 userText）
- Modify: `src/headless.ts:47-50`（prompt 提交前 dispatch；block→直接返回 aborted）
- Test: `test/useChat.hooks.test.ts`（新建，mock runHooks）

**语义（对齐 CC processUserInput.ts:178-263）：** `decision:block`/exit2（→`outcome.block`/`outcome.preventContinuation`）→ 不提交本次输入，提示用户；`additionalContext` → 附到 user 消息（不阻断）。

- [ ] **Step 1: 写失败测试（新建文件）**

创建 `test/useChat.hooks.test.ts`：

```typescript
// test/useChat.hooks.test.ts —— L-042 ①b-1：useChat 自有事件（mock runHooks 注入受控 outcome）
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const script: Array<{ deltas?: any[]; result: any }> = []
vi.mock('../src/api.js', async orig => ({
  ...(await orig() as any),
  chatStream: vi.fn(() =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      for (const d of scene.deltas ?? []) yield typeof d === 'string' ? { type: 'text', delta: d } : d
      return scene.result
    })(),
  ),
}))

// 受控 runHooks：按 event 返回测试设定的 outcome；记录每次调用。
const emptyOutcome = { block: false, preventContinuation: false, stop: false, results: [] }
const hookCalls: Array<{ event: string; payload: any }> = []
let hookImpl: (event: string, payload: any) => any = () => emptyOutcome
vi.mock('../src/hooks.js', async orig => ({
  ...(await orig() as any),
  runHooks: vi.fn(async (event: string, payload: any) => { hookCalls.push({ event, payload }); return hookImpl(event, payload) }),
}))

import { createChatCore } from '../src/tui/useChat.js'

const usage = { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0 }
let sessionDir: string
beforeEach(() => {
  script.length = 0
  hookCalls.length = 0
  hookImpl = () => emptyOutcome
  vi.clearAllMocks()
  sessionDir = mkdtempSync(path.join(tmpdir(), 'deepcode-hooks-'))
})

describe('useChat UserPromptSubmit hook', () => {
  it('正常输入 → UserPromptSubmit 以 prompt 文本触发，照常跑', async () => {
    script.push({ result: { content: '回答', toolCalls: [], usage, finishReason: 'stop' } })
    const core = createChatCore({ client: {} as any, yolo: true, cwd: process.cwd(), sessionDir, onState: () => {} })
    await core.send('你好世界')
    const ups = hookCalls.find(c => c.event === 'UserPromptSubmit')
    expect(ups).toBeTruthy()
    expect(ups!.payload.prompt).toContain('你好世界')
  })

  it('UserPromptSubmit block → 拦截本次输入，不发起 API', async () => {
    hookImpl = (event) => event === 'UserPromptSubmit'
      ? { ...emptyOutcome, block: true, blockReason: '含敏感词' }
      : emptyOutcome
    const core = createChatCore({ client: {} as any, yolo: true, cwd: process.cwd(), sessionDir, onState: () => {} })
    await core.send('泄密内容')
    // 未发起 API：script 未被消费
    expect(script.length).toBe(1)
  })
})
```

> 测试前确认 `createChatCore` 返回对象暴露 `send`。若实际方法名不同（如 `submit`），按 useChat.ts 导出的真实名调整。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/useChat.hooks.test.ts -t "UserPromptSubmit"`
Expected: FAIL —— 当前 runTurn 不 dispatch UserPromptSubmit；block 用例 script 被消费（length 0）。

- [ ] **Step 3: 实现 useChat UserPromptSubmit**

`src/tui/useChat.ts` 的 `runTurn`（line 347），在函数体最开头（`busy = true` 之前）插入 dispatch + 拦截。注意 `runTurn` 当前签名 `(displayLine, userText)`，且无返回拦截路径——改为 dispatch 后判断：

```typescript
  const runTurn = async (displayLine: string, userText: string): Promise<void> => {
    // UserPromptSubmit hook：用户输入提交前。block/preventContinuation→拦截不发；additionalContext→附到 user 文本。
    if (settings.hooks) {
      const ups = await runHooks('UserPromptSubmit', {
        hook_event_name: 'UserPromptSubmit', cwd, prompt: userText,
      }, settings.hooks)
      if (ups.block || ups.preventContinuation) {
        dispatch({ type: 'push', item: { kind: 'user', text: displayLine } })
        notice('warn', `输入被 hook 拦截：${ups.blockReason ?? '（无原因）'}`)
        return
      }
      if (ups.additionalContext) userText = `${userText}\n\n<hook-context>\n${ups.additionalContext}\n</hook-context>`
    }
    busy = true
    turnStartAt = Date.now()
    turnOutTokens = 0
```

> 其余 runTurn 函数体不变。`userText` 在后续 `userMsg.content` 构造时已被使用，注入的 additionalContext 自然带入。

- [ ] **Step 4: headless UserPromptSubmit**

`src/headless.ts`，在 `const messages: any[] = [...]`（line 47）之前插入 dispatch + 提前返回：

```typescript
  if (settings.hooks) {
    const ups = await runHooks('UserPromptSubmit', {
      hook_event_name: 'UserPromptSubmit', cwd, prompt: opts.prompt,
    }, settings.hooks)
    if (ups.block || ups.preventContinuation) {
      return { text: `输入被 hook 拦截：${ups.blockReason ?? ''}`, status: 'aborted', turns: 0, usage: total, costUSD: 0 }
    }
  }
  const messages: any[] = [
    { role: 'system', content: buildSystemPrompt(cwd) },
    { role: 'user', content: ups_inject(opts.prompt) },
  ]
```

> 上面 `ups_inject` 是伪占位——实际改为：在 dispatch 块内用 `let promptText = opts.prompt`，`additionalContext` 时 `promptText += ...`，messages 用 `promptText`。完整写法：

```typescript
  let promptText = opts.prompt
  if (settings.hooks) {
    const ups = await runHooks('UserPromptSubmit', {
      hook_event_name: 'UserPromptSubmit', cwd, prompt: opts.prompt,
    }, settings.hooks)
    if (ups.block || ups.preventContinuation) {
      return { text: `输入被 hook 拦截：${ups.blockReason ?? ''}`, status: 'aborted', turns: 0, usage: total, costUSD: 0 }
    }
    if (ups.additionalContext) promptText = `${opts.prompt}\n\n<hook-context>\n${ups.additionalContext}\n</hook-context>`
  }
  const messages: any[] = [
    { role: 'system', content: buildSystemPrompt(cwd) },
    { role: 'user', content: promptText },
  ]
```

> 注意 `total` 变量在 headless line 39 已声明（`const total: Usage`），此提前返回点在其后，可用。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run test/useChat.hooks.test.ts -t "UserPromptSubmit"`
Expected: PASS。

- [ ] **Step 6: 全量 + commit**

```bash
npm test && npm run typecheck && npm run build
git add src/tui/useChat.ts src/headless.ts test/useChat.hooks.test.ts
git commit -m "feat(hooks): UserPromptSubmit block/context injection (L-042 ①b-1)"
```

---

## Task 6: PreCompact / PostCompact hooks

**Files:**
- Modify: `src/tui/useChat.ts:322-337`（doCompact 前后 dispatch）
- Test: `test/useChat.hooks.test.ts`（追加；mock runHooks 已就位，需让 summarize 可控）

**语义（对齐 CC compact.ts:413-423）：** PreCompact 前触发（trigger=auto/manual）；PostCompact 后触发（带 summary）。本件 PreCompact 暂不消费返回（custom_instructions 改写留 ①b-2/后续；deepcode summarize 当前无 custom_instructions 入参）——仅 dispatch 记录。

- [ ] **Step 1: 写失败测试**

`doCompact` 内部调用 `summarize(opts.client, messages, signal)`（来自 `../compact.js`?）。先确认 summarize 的来源模块（useChat.ts 顶部 import），测试用 `vi.mock` 该模块返回固定 summary。在 `test/useChat.hooks.test.ts` 顶部 mock 区（紧跟 hooks mock 之后）加：

```typescript
vi.mock('../src/compact.js', async orig => ({
  ...(await orig() as any),
  summarize: vi.fn(async () => ({ summary: '历史总结', usage, truncated: false })),
}))
```

> 若 `summarize` 实际不在 `../src/compact.js`，按 useChat.ts 顶部 import 路径修正 mock 目标。

在文件末尾追加 describe：

```typescript
describe('useChat PreCompact/PostCompact hook', () => {
  it('手动 /compact → PreCompact(trigger=manual) 与 PostCompact 依次触发', async () => {
    // 先发一轮普通消息，让 messages 有内容
    script.push({ result: { content: '答', toolCalls: [], usage, finishReason: 'stop' } })
    const core = createChatCore({ client: {} as any, yolo: true, cwd: process.cwd(), sessionDir, onState: () => {} })
    await core.send('问题')
    hookCalls.length = 0
    await core.send('/compact')
    const pre = hookCalls.find(c => c.event === 'PreCompact')
    const post = hookCalls.find(c => c.event === 'PostCompact')
    expect(pre).toBeTruthy()
    expect(pre!.payload.trigger).toBe('manual')
    expect(post).toBeTruthy()
    expect(post!.payload.summary).toBe('历史总结')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/useChat.hooks.test.ts -t "PreCompact"`
Expected: FAIL —— doCompact 未 dispatch。

- [ ] **Step 3: 实现 doCompact 的 Pre/PostCompact**

`src/tui/useChat.ts`，把 `doCompact` 改为接受 `trigger` 参数并在前后 dispatch。替换 line 322-337 的 `doCompact`：

```typescript
  const doCompact = async (trigger: 'auto' | 'manual' = 'auto'): Promise<void> => {
    notice('info', '[compact 总结中…]')
    const ac = new AbortController()
    if (settings.hooks) {
      await runHooks('PreCompact', {
        hook_event_name: 'PreCompact', cwd, trigger, messages_count: messages.length,
      }, settings.hooks)
    }
    const { summary, usage: u, truncated } = await summarize(opts.client, messages, ac.signal)
    usageLog.push({ usage: u, model: 'deepseek-v4-flash' })
    session.appendUsage(u, 'deepseek-v4-flash')
    const rebuilt = rebuildMessages(messages, summary)
    const before = messages.length
    messages.length = 0
    messages.push(...rebuilt)
    session.appendCompact()
    for (const m of messages) session.appendMessage(m)
    compacted = true
    lastPromptTokens = 0
    if (settings.hooks) {
      await runHooks('PostCompact', {
        hook_event_name: 'PostCompact', cwd, trigger, summary, truncated,
        messages_before: before, messages_after: messages.length,
      }, settings.hooks)
    }
    notice('info', 'compact 完成：历史已压缩为总结 + 最近 8 条（fileState 保留）')
    if (truncated) notice('warn', '[compact 警告] 总结被长度截断，信息可能有损')
  }
```

改两个调用点（已核实位置）：
- **line 448**（自动 compact，catch 文案「[自动 compact 失败…]」）：`try { await doCompact() }` → `try { await doCompact('auto') }`
- **line 537**（手动 `/compact` 命令，catch 文案「[compact 失败]」）：`try { await doCompact() }` → `try { await doCompact('manual') }`

> 定义处默认值 `'auto'` 保证遗漏时不破。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/useChat.hooks.test.ts -t "PreCompact"`
Expected: PASS。

- [ ] **Step 5: 全量 + commit**

```bash
npm test && npm run typecheck && npm run build
git add src/tui/useChat.ts test/useChat.hooks.test.ts
git commit -m "feat(hooks): PreCompact/PostCompact dispatch (L-042 ①b-1)"
```

---

## Task 7: PermissionRequest / PermissionDenied hooks

**Files:**
- Modify: `src/permissions.ts:7-68`（`PermissionHooks` 接口 + checkPermission 加可选第 4 参）
- Modify: `src/loop.ts:78-98`（execCall 构造 permHooks 传入 checkPermission）
- Test: `test/permissions.test.ts`

**语义（对齐 spec §3）：** PermissionRequest 在交互 ask **之前**触发，hook `allow`→跳过弹窗放行、`deny`→拒绝；PermissionDenied 在判定拒绝**之后**触发（记录/通知）。放在 checkPermission 内部确保只在真正要 ask 时触发（yolo/已有规则短路时不触发）。

- [ ] **Step 1: 写失败测试**

在 `test/permissions.test.ts` 末尾追加（先看文件顶部已 import 的 `checkPermission` 和造 tool 的 helper；下面自带最小 tool）：

```typescript
describe('checkPermission + hooks', () => {
  const writeTool: any = {
    name: 'Write', isReadOnly: false,
    needsPermission: () => 'write /etc/passwd',
    inputSchema: { safeParse: (x: any) => ({ success: true, data: x }) },
    call: async () => 'ok',
  }
  const pc = (decision: any) => ({ mode: 'default' as const, rules: [], saveRule: () => {}, ask: async () => decision })

  it('PermissionRequest hook allow → 跳过弹窗直接放行（ask 不被调用）', async () => {
    const ask = vi.fn(async () => 'no' as const)
    const hooks = {
      onRequest: async () => ({ block: false, preventContinuation: false, stop: false, results: [], permission: 'allow' as const }),
      onDenied: vi.fn(async () => {}),
    }
    const r = await checkPermission(writeTool, {}, { mode: 'default', rules: [], saveRule: () => {}, ask }, hooks)
    expect(r.ok).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('PermissionRequest hook deny → 拒绝并触发 onDenied', async () => {
    const denied: string[] = []
    const hooks = {
      onRequest: async () => ({ block: false, preventContinuation: false, stop: false, results: [], permission: 'deny' as const, permissionReason: '禁写系统文件' }),
      onDenied: async (_n: string, _d: string, reason: string) => { denied.push(reason) },
    }
    const r = await checkPermission(writeTool, {}, pc('no'), hooks)
    expect(r.ok).toBe(false)
    expect(denied[0]).toBe('禁写系统文件')
  })

  it('用户拒绝 → onDenied 以「用户拒绝」触发', async () => {
    const denied: string[] = []
    const hooks = {
      onRequest: async () => ({ block: false, preventContinuation: false, stop: false, results: [] }),
      onDenied: async (_n: string, _d: string, reason: string) => { denied.push(reason) },
    }
    const r = await checkPermission(writeTool, {}, pc('no'), hooks)
    expect(r.ok).toBe(false)
    expect(denied[0]).toContain('用户拒绝')
  })
})
```

> 顶部确保 `import { describe, it, expect, vi } from 'vitest'` 含 `vi`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/permissions.test.ts -t "hooks"`
Expected: FAIL —— checkPermission 当前只有 3 个参数，无 hook 分支。

- [ ] **Step 3: 实现 PermissionHooks + checkPermission 分支**

`src/permissions.ts`，顶部 import 区加：

```typescript
import type { HookOutcome } from './hooks.js'
```

在 `PermissionContext` 接口之后加 `PermissionHooks` 接口：

```typescript
export interface PermissionHooks {
  /** 交互 ask 前：hook 可返回 permission==='allow'（跳弹窗放行）或 'deny'/block（拒绝）。 */
  onRequest?: (toolName: string, desc: string) => Promise<HookOutcome>
  /** 判定拒绝后：记录/通知。 */
  onDenied?: (toolName: string, desc: string, reason: string) => Promise<void>
}
```

把 `checkPermission`（line 44-68）替换为带 hooks 分支的版本：

```typescript
export async function checkPermission(
  tool: Tool<any>,
  input: unknown,
  pc: PermissionContext,
  hooks?: PermissionHooks,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (tool.isReadOnly) return { ok: true }
  const desc = tool.needsPermission(input)
  if (desc === false) return { ok: true }
  if (pc.mode === 'yolo') return { ok: true }
  if (pc.mode === 'acceptEdits' && (tool.name === 'Edit' || tool.name === 'Write')) return { ok: true }
  if (pc.rules.some(r => matchRule(r, tool.name, desc))) return { ok: true }
  // PermissionRequest hook：交互 ask 前。allow→跳弹窗放行；deny/block→拒绝。
  if (hooks?.onRequest) {
    const out = await hooks.onRequest(tool.name, desc)
    if (out.permission === 'allow') return { ok: true }
    if (out.permission === 'deny' || out.block) {
      const reason = out.permissionReason ?? out.blockReason ?? '权限被 hook 拒绝'
      await hooks.onDenied?.(tool.name, desc, reason)
      return { ok: false, reason }
    }
  }
  const decision = await pc.ask(tool.name, desc)
  if (decision === 'always') {
    const firstLine = desc.split('\n')[0]
    const pat = tool.name === 'Bash'
      ? isDangerous(desc)
        ? desc.replace(/\n/g, ' ')
        : firstLine.split(' ').slice(0, 2).join(' ') + ':*'
      : desc.replace(/\n/g, ' ')
    pc.saveRule(`${tool.name}(${pat})`)
    return { ok: true }
  }
  if (decision === 'yes') return { ok: true }
  await hooks?.onDenied?.(tool.name, desc, '用户拒绝了此操作')
  return { ok: false, reason: '用户拒绝了此操作' }
}
```

- [ ] **Step 4: loop.ts execCall 传入 permHooks**

`src/loop.ts`，把 execCall 的权限检查段（line 95-98）替换为构造 permHooks 并传入：

```typescript
  if (!preAllow) {
    const permHooks = deps.hooks ? {
      onRequest: (name: string, d: string) =>
        runHooks('PermissionRequest', { hook_event_name: 'PermissionRequest', cwd, tool_name: name, tool_desc: d }, deps.hooks),
      onDenied: async (name: string, d: string, reason: string) => {
        await runHooks('PermissionDenied', { hook_event_name: 'PermissionDenied', cwd, tool_name: name, tool_desc: d, reason }, deps.hooks)
      },
    } : undefined
    const perm = await checkPermission(tool, input, deps.permission, permHooks)
    if (!perm.ok) return { ok: false, content: perm.reason, ms: 0 }
  }
```

> `checkPermission` 已在 loop.ts:6 import；`PermissionHooks` 类型无需显式 import（结构匹配即可，但若 typecheck 报参数类型不符，加 `import { checkPermission, type PermissionContext, type PermissionHooks } from './permissions.js'`）。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run test/permissions.test.ts -t "hooks"`
Expected: PASS（三例）。

- [ ] **Step 6: 全量 + commit**

```bash
npm test && npm run typecheck && npm run build
git add src/permissions.ts src/loop.ts test/permissions.test.ts
git commit -m "feat(hooks): PermissionRequest/PermissionDenied via checkPermission hooks (L-042 ①b-1)"
```

---

## Self-Review 结论

- **Spec 覆盖：** ①b-1 范围内的 9 个事件（Stop/StopFailure/SubagentStart/SubagentStop/UserPromptSubmit/PreCompact/PostCompact/PermissionRequest/PermissionDenied）各有 Task 覆盖；I-1（Stop 类读 preventContinuation 非 block）在 Task 2/4 落实；once 不消费 + 注释在 Task 1。**①b-2 事件**（SessionStart/SessionEnd/Setup/TaskCreated/TaskCompleted/Notification/ConfigChange/CwdChanged/InstructionsLoaded + env file 机制）不在本计划，另立计划。
- **类型一致：** `hookDispatch(event, payload): Promise<HookOutcome>` 在 types.ts 定义、agent.ts/useChat/headless 使用签名一致；`PermissionHooks.onRequest` 返回 `HookOutcome`、消费 `.permission`/`.block`/`.permissionReason`/`.blockReason` 均为 HookOutcome 已有字段；Stop/SubagentStop 续跑读 `.preventContinuation`/`.blockReason`/`.stop` 一致。
- **已核实（无需再查）：** `createChatCore` 提交方法 = `send`（useChat.ts:633）；`summarize` 来自 `../compact.js`（Task 6 mock `../src/compact.js` 正确）；`doCompact()` 调用点 line 448(auto)/537(manual)；useChat.ts 当前**未** import `runHooks`（Task 1 必加）；headless `total` 在 line 39 声明、提前返回点（line 47 前）可见。

---

## 执行交接

计划已存 `docs/plans/2026-06-16-deepcode-l042b1-hooks-core-events.md`。建议 **Subagent-Driven**（每 Task 一个 fresh implementer + 规格审查 + 质量审查双门；Task 2/4 涉及续跑状态机，末尾加 opus 全量终审）。纯逻辑免真机冒烟。合并走 `finishing-a-development-branch`。
