# L-044 结构化输出强约束（StructuredOutput）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 deepcode 子代理可靠产出机器可解析的结构化结果（StructuredOutput 工具 + 强约束续跑），并用它消除 ①c agent hook 的 `{ok,reason}` 文本解析近似。

**Architecture:** 对齐 CC 机制（SyntheticOutputTool + Stop-hook 强约束 + 重试上限），宿主适配为 deepcode zod-native。共享原语 `src/tools/structuredOutput.ts`（工具工厂 + 常量 + 提醒）；强约束作为**框架逻辑内联**在子代理子循环结束点（runSub 的 SubagentStop 生命周期 + hookRuntime.runAgent），不进 settings 配置 hook、不加 function-hook 类型。结果经工具 `call` 的 `onValid` 回调捕获，子循环返回 `JSON.stringify(校验对象)`。

**Tech Stack:** TypeScript / ESM / zod / zod-to-json-schema / vitest。

**Spec:** `docs/specs/2026-06-17-deepcode-l044-structured-output-design.md`。

**关键对齐点：**
- 工具名 `StructuredOutput`（对齐 CC）；重试上限 5（对齐 CC `MAX_STRUCTURED_OUTPUT_RETRIES`）。
- 校验用 **zod**（deepcode 工具系统 zod-native，非 CC 的 AJV/JSON Schema）。
- 强约束 = runSub/runAgent 内联框架逻辑（deepcode hooks 引擎配置驱动、无 function-hook 类型）。
- fail-safe：重试耗尽 → 回退末条文本，绝不死循环/误 block。

**不做（YAGNI）：** 不引 AJV、不加顶层 `--json-schema` CLI、不加 `structured_output` attachment 消息类型、不加重试上限 env、不改 hooks 引擎、不碰 TUI（纯逻辑免冒烟）。

**测试基线命令：** 单测 `npm test -- <file>`；全量 `npm test`；类型 `npm run typecheck`；构建 `npm run build`。

---

### Task 1: 共享原语 `src/tools/structuredOutput.ts`

StructuredOutput 工具工厂 + 常量 + 续跑提醒。纯逻辑。

**Files:**
- Create: `src/tools/structuredOutput.ts`
- Test: `test/structuredOutput.test.ts`

- [ ] **Step 1: 写失败测试**

Create `test/structuredOutput.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { makeStructuredOutputTool, STRUCTURED_OUTPUT_TOOL_NAME, MAX_STRUCTURED_OUTPUT_RETRIES, structuredOutputReminder } from '../src/tools/structuredOutput.js'

const schema = z.object({ ok: z.boolean(), reason: z.string().optional() })
const ctx: any = { cwd: () => process.cwd(), setCwd: () => {}, signal: new AbortController().signal, fileState: new Map() }

describe('structuredOutput 常量', () => {
  it('工具名与重试上限对齐 CC', () => {
    expect(STRUCTURED_OUTPUT_TOOL_NAME).toBe('StructuredOutput')
    expect(MAX_STRUCTURED_OUTPUT_RETRIES).toBe(5)
    expect(structuredOutputReminder()).toContain('StructuredOutput')
  })
})

describe('makeStructuredOutputTool', () => {
  it('合 schema → onValid 收到规范化对象 + 返回成功串', async () => {
    const seen: unknown[] = []
    const tool = makeStructuredOutputTool(schema, v => seen.push(v))
    expect(tool.name).toBe('StructuredOutput')
    expect(tool.isReadOnly).toBe(true)
    expect(tool.needsPermission({} as any)).toBe(false)
    const out = await tool.call({ ok: false, reason: '不通过' }, ctx)
    expect(seen).toEqual([{ ok: false, reason: '不通过' }])
    expect(out).toContain('已记录')
  })

  it('不合 schema → 返回错误串、onValid 不被调', async () => {
    const onValid = vi.fn()
    const tool = makeStructuredOutputTool(schema, onValid)
    const out = await tool.call({ ok: 'yes' } as any, ctx)
    expect(onValid).not.toHaveBeenCalled()
    expect(out).toContain('错误')
    expect(out).toContain(STRUCTURED_OUTPUT_TOOL_NAME)
  })

  it('inputSchema 即传入 schema（API 层经 toApiTools 暴露给模型）', () => {
    const tool = makeStructuredOutputTool(schema, () => {})
    expect(tool.inputSchema).toBe(schema)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- test/structuredOutput.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

Create `src/tools/structuredOutput.ts`：

```ts
// src/tools/structuredOutput.ts —— L-044 结构化输出强约束的共享原语。
// 对齐 CC SyntheticOutputTool（工具名 StructuredOutput、重试上限 5），宿主适配为 zod 校验。
// 强约束循环本身内联在调用方（agent.ts runSub / hookRuntime.ts runAgent），本模块只提供工具工厂 + 常量。
import type { z } from 'zod'
import type { Tool } from './types.js'

export const STRUCTURED_OUTPUT_TOOL_NAME = 'StructuredOutput'
export const MAX_STRUCTURED_OUTPUT_RETRIES = 5 // 对齐 CC MAX_STRUCTURED_OUTPUT_RETRIES 默认值

/** 子代理未调 StructuredOutput 就想结束时，注入此提醒强制重试。 */
export function structuredOutputReminder(): string {
  return `你必须调用 ${STRUCTURED_OUTPUT_TOOL_NAME} 工具，按要求的结构返回最终答案。现在就调用它。`
}

/** StructuredOutput 工具工厂：按给定 zod schema 校验入参，成功经 onValid 捕获规范化对象。
 *  仅在声明了 outputSchema 的子代理/agent-hook 工具池里动态注入（不进全局池）。 */
export function makeStructuredOutputTool(schema: z.ZodTypeAny, onValid: (value: unknown) => void): Tool<z.ZodTypeAny> {
  return {
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    description: '把你的最终答案按要求的结构化格式返回。在回复末尾必须且只调用一次本工具。',
    inputSchema: schema, // API 层 toApiTools→zodToJsonSchema 把 schema 作为工具 parameters 暴露给模型
    isReadOnly: true,
    needsPermission: () => false,
    async call(input) {
      // loop.ts execCall 通常已对 inputSchema safeParse 过；此处再 parse 取规范化值并捕获（防御 + 拿 zod 转换值）。
      const parsed = schema.safeParse(input)
      if (!parsed.success) {
        const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
        return `错误：输出不符合要求的结构：${issues}。请按结构重新调用 ${STRUCTURED_OUTPUT_TOOL_NAME}。`
      }
      onValid(parsed.data)
      return '已记录结构化输出。'
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- test/structuredOutput.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/structuredOutput.ts test/structuredOutput.test.ts
git commit -m "feat(agent): StructuredOutput 工具工厂 + 常量 (L-044)"
```

---

### Task 2: `AgentDefinition.outputSchema` + runSub 强约束循环

子代理声明 outputSchema 时，注入 StructuredOutput 工具 + 强制调用 + 返回校验 JSON。

**Files:**
- Modify: `src/tools/agentTypes.ts`（`AgentDefinition` 加字段）
- Modify: `src/tools/agent.ts`（runSub 强约束）
- Test: `test/agent.test.ts`

- [ ] **Step 1: 写失败测试**

`test/agent.test.ts` 追加（顶部已 `vi.mock('../src/api.js')` 脚本驱动 chatStream，runLoop/工具是真的；新增需 import `z`、`BUILTIN_AGENTS`、`STRUCTURED_OUTPUT_TOOL_NAME`）：

```ts
import { z } from 'zod'
import { BUILTIN_AGENTS } from '../src/tools/agentTypes.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../src/tools/structuredOutput.js'

describe('Agent 结构化输出强约束 (L-044)', () => {
  // 临时注册一个带 outputSchema 的测试 agent；afterEach 移除，避免污染注册表。
  const TEST_TYPE = '__l044_test__'
  const testDef = {
    agentType: TEST_TYPE, whenToUse: 'test',
    disallowedTools: ['Edit', 'Write', 'Agent'], model: 'flash' as const,
    outputSchema: z.object({ count: z.number(), note: z.string() }),
    getSystemPrompt: () => '你是测试子代理。',
  }
  beforeEach(() => { BUILTIN_AGENTS.push(testDef) })
  afterEach(() => { const i = BUILTIN_AGENTS.indexOf(testDef); if (i >= 0) BUILTIN_AGENTS.splice(i, 1) })

  it('子代理调用 StructuredOutput → 返回校验后 JSON（非自由文本）', async () => {
    script.push(
      { result: { content: '', toolCalls: [{ id: 'so1', name: STRUCTURED_OUTPUT_TOOL_NAME, args: JSON.stringify({ count: 3, note: '三个' }) }], usage, finishReason: 'tool_calls' } },
      { result: { content: '完成了', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: 't', prompt: '数一下', subagent_type: TEST_TYPE }, ctx())
    expect(JSON.parse(out)).toEqual({ count: 3, note: '三个' })
  })

  it('首轮未调 StructuredOutput → 注入提醒续跑，次轮调了 → 成功', async () => {
    script.push(
      { result: { content: '我直接说答案：3 个', toolCalls: [], usage, finishReason: 'stop' } }, // 首轮不调
      { result: { content: '', toolCalls: [{ id: 'so1', name: STRUCTURED_OUTPUT_TOOL_NAME, args: JSON.stringify({ count: 3, note: 'x' }) }], usage, finishReason: 'tool_calls' } },
      { result: { content: 'done', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: 't', prompt: '数一下', subagent_type: TEST_TYPE }, ctx())
    expect(JSON.parse(out)).toEqual({ count: 3, note: 'x' })
  })

  it('连续不调 → 重试耗尽后兜底返回末条文本（不死循环）', async () => {
    // 推 MAX+2 幕「不调」场景；超限后兜底返回末条 assistant 文本。
    for (let i = 0; i < 8; i++) script.push({ result: { content: '就是不调工具', toolCalls: [], usage, finishReason: 'stop' } })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: 't', prompt: '数一下', subagent_type: TEST_TYPE }, ctx())
    expect(out).toBe('就是不调工具') // 兜底末条文本
  })

  it('无 outputSchema 的内建 agent → 行为不变（返回末条文本）', async () => {
    script.push({ result: { content: '普通文本结果', toolCalls: [], usage, finishReason: 'stop' } })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: 't', prompt: 'x', subagent_type: 'general-purpose' }, ctx())
    expect(out).toBe('普通文本结果')
  })
})
```

> 注：`test/agent.test.ts` 顶部 `beforeEach` 已有 `script.length = 0` 等清理；本 describe 的 `beforeEach`/`afterEach` 叠加。确保 import `afterEach`（vitest）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- test/agent.test.ts`
Expected: 新用例 FAIL（outputSchema 未生效，返回末条文本而非 JSON）

- [ ] **Step 3a: 实现 `AgentDefinition.outputSchema`**

`src/tools/agentTypes.ts` 顶部确保 `import { z } from 'zod'`（若无则加），`AgentDefinition` 接口加字段：

```ts
  /** L-044：声明则强制子代理用 StructuredOutput 工具按此 schema 产出，结果取校验对象的 JSON（非自由文本）。 */
  outputSchema?: z.ZodTypeAny
```

- [ ] **Step 3b: 实现 runSub 强约束（`src/tools/agent.ts`）**

顶部加 import：

```ts
import { makeStructuredOutputTool, structuredOutputReminder, MAX_STRUCTURED_OUTPUT_RETRIES } from './structuredOutput.js'
```

把 `runSub` 内的工具池与子循环改为支持强约束。在 `runSub` 函数体内、`const subCtx` 之后、`let subStopFired = false` 附近，加结构化输出状态与工具注入：

```ts
        let subStopFired = false
        // L-044：声明 outputSchema → 注入 StructuredOutput 工具，强制子代理产出校验对象。
        let captured: unknown
        let structuredRetries = 0
        const subTools = def.outputSchema
          ? [...tools, makeStructuredOutputTool(def.outputSchema, v => { captured = v })]
          : tools
```

把子循环里 `tools,` 一行改为 `tools: subTools,`。然后在每轮 runLoop 结束后、现有 SubagentStop dispatch **之前**，插入强约束检查：

```ts
          const final = [...messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content)
          // L-044 强约束：声明了 schema 但本轮还没拿到校验对象 → 注入提醒续跑（≤MAX 次；独立于 subStopFired 配额）。
          if (def.outputSchema && captured === undefined) {
            if (structuredRetries < MAX_STRUCTURED_OUTPUT_RETRIES) {
              structuredRetries++
              messages.push({ role: 'user', content: structuredOutputReminder() })
              continue
            }
            // 超限：fail-safe 兜底返回末条文本（不死循环）。
          }
          if (ctx.hookDispatch && !signal.aborted) {
            const stopOut = await ctx.hookDispatch('SubagentStop', {
              hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: type, cwd: ctx.cwd(),
              stop_hook_active: subStopFired,
              last_assistant_message: final?.content ?? '',
            })
            if (stopOut.stop) return captured !== undefined ? JSON.stringify(captured) : final?.content
            if (stopOut.preventContinuation && !subStopFired) {
              subStopFired = true
              messages.push({ role: 'user', content: stopOut.blockReason ?? '（SubagentStop 要求继续未尽事项）' })
              continue
            }
          }
          return captured !== undefined ? JSON.stringify(captured) : final?.content
```

> 关键：两处 `return`（SubagentStop `stop` 路径 + 末尾默认路径）都改为「有 captured 返回 JSON、否则末条文本」。结构化重试用独立 `structuredRetries`，不消耗 `subStopFired`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- test/agent.test.ts`
Expected: PASS（含原有用例——无 outputSchema 路径完全不变）

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: 干净

- [ ] **Step 6: 提交**

```bash
git add src/tools/agentTypes.ts src/tools/agent.ts test/agent.test.ts
git commit -m "feat(agent): AgentDefinition.outputSchema + runSub 结构化输出强约束 (L-044)"
```

---

### Task 3: capstone —— 消除 ①c agent hook 的 `{ok,reason}` 文本解析

`hookRuntime.runAgent` 用 StructuredOutput 强约束产出合 schema 的 `{ok,reason}` JSON 串；`parseHookEvalResult` 解析端零改（fail-safe 保留）。

**Files:**
- Modify: `src/hookRuntime.ts`（runAgent 强约束 + `HOOK_EVAL_SCHEMA`）
- Modify: `src/hooks.ts`（`AGENT_HOOK_SYSTEM` 文案改为指示调用 StructuredOutput）
- Test: `test/hookRuntime.test.ts`、`test/hooks.test.ts`

- [ ] **Step 1: 写失败测试**

`test/hookRuntime.test.ts` 追加（脚本驱动 chatStream + 真 runLoop/工具）：

```ts
import { z } from 'zod'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../src/tools/structuredOutput.js'

describe('makeHookRuntime.runAgent 结构化输出 (L-044)', () => {
  it('hook 子代理调 StructuredOutput({ok:false,reason}) → runAgent 返回该 JSON 串', async () => {
    script.length = 0
    script.push(
      { result: { content: '', toolCalls: [{ id: 'so1', name: STRUCTURED_OUTPUT_TOOL_NAME, args: JSON.stringify({ ok: false, reason: '不达标' }) }], usage, finishReason: 'tool_calls' } },
      { result: { content: 'done', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const rt = makeHookRuntime({ client: {} as any, getModel: () => 'deepseek-v4-flash', cwd: () => process.cwd() })
    const text = await rt.runAgent!('核查', undefined, new AbortController().signal)
    expect(JSON.parse(text)).toEqual({ ok: false, reason: '不达标' })
  })

  it('hook 子代理始终不调 → 重试耗尽兜底返回末条文本（parseHookEvalResult 端 fail-safe）', async () => {
    script.length = 0
    for (let i = 0; i < 8; i++) script.push({ result: { content: '自由文本结论', toolCalls: [], usage, finishReason: 'stop' } })
    const rt = makeHookRuntime({ client: {} as any, getModel: () => 'deepseek-v4-flash', cwd: () => process.cwd() })
    const text = await rt.runAgent!('核查', undefined, new AbortController().signal)
    expect(text).toBe('自由文本结论')
  })
})
```

`test/hooks.test.ts` 的 `runHooks agent 类型` 处补一例（确认 execAgentHook 经 runAgent 拿结构化 JSON → blocking）。先 Read 现有 `runHooks agent 类型` describe 的注入风格（它注入假 `runAgent`），追加：

```ts
  it('agent hook：runAgent 返回 {ok:false,reason} → blocking', async () => {
    const runAgent = vi.fn(async () => JSON.stringify({ ok: false, reason: '不通过' }))
    const cfg: HooksConfig = { PreToolUse: [{ hooks: [{ type: 'agent', prompt: '核查' }] }] }
    const o = await runHooks('PreToolUse', { tool_name: 'Write' }, cfg, { runAgent } as any)
    expect(o.block).toBe(true)
    expect(o.blockReason).toBe('不通过')
  })
```

> 若 `runHooks agent 类型` 已有等价断言，跳过此例、只保留 hookRuntime 的两例。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- test/hookRuntime.test.ts`
Expected: 新用例 FAIL（runAgent 未注入 StructuredOutput、返回末条文本而非 JSON）

- [ ] **Step 3a: 实现 runAgent 强约束（`src/hookRuntime.ts`）**

顶部加 import：

```ts
import { z } from 'zod'
import { makeStructuredOutputTool, structuredOutputReminder, MAX_STRUCTURED_OUTPUT_RETRIES } from './tools/structuredOutput.js'
```

定义 schema（放 import 之后、`makeHookRuntime` 之前）：

```ts
/** agent hook 的固定输出 schema（对齐 ①c {ok,reason} 契约）。 */
const HOOK_EVAL_SCHEMA = z.object({ ok: z.boolean(), reason: z.string().optional() })
```

把 `runAgent` 改为强约束循环——注入 StructuredOutput 工具、强制调用、返回 `JSON.stringify(captured)` 或兜底末条文本。将现有 runAgent 体（单次 runLoop + 取末条文本）替换为：

```ts
  const runAgent: HookEngineDeps['runAgent'] = async (prompt, model, signal) => {
    const subModel = resolveModel(model, opts.getModel)
    const subCtx: ToolContext = {
      cwd: opts.cwd,
      setCwd: () => { /* hook 子代理只读，不漂移 cwd */ },
      get signal() { return signal },
      fileState: new Map(),
      isSubagent: true, // 纯执行 + 不注入 hookDispatch → 子回路 hooks-free 防递归
    }
    const messages: any[] = [{ role: 'user', content: prompt }]
    // L-044：注入 StructuredOutput 工具，强制 hook 子代理产出 {ok,reason}（替代 ①c 的自由文本解析近似）。
    let captured: unknown
    const tools = [...HOOK_AGENT_TOOLS, makeStructuredOutputTool(HOOK_EVAL_SCHEMA, v => { captured = v })]
    let structuredRetries = 0
    while (true) {
      const gen = runLoop(messages, {
        client: opts.client,
        tools,
        model: subModel,
        thinking: false,
        permission: { mode: 'default', rules: [], saveRule: () => {}, ask: async (_n, desc) => subagentPermissionDecision(desc) },
        ctx: subCtx,
        maxTurns: 10,
      })
      let step
      while (!(step = await gen.next()).done) {
        if (step.value.type === 'turn_end' && opts.onUsage) opts.onUsage(step.value.usage, subModel)
      }
      if (captured !== undefined) return JSON.stringify(captured)
      if (structuredRetries < MAX_STRUCTURED_OUTPUT_RETRIES) {
        structuredRetries++
        messages.push({ role: 'user', content: structuredOutputReminder() })
        continue
      }
      // fail-safe：重试耗尽 → 回退末条文本（parseHookEvalResult 解析失败 → non_blocking_error 不 block）。
      const final = [...messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content)
      return final?.content ?? ''
    }
  }
```

- [ ] **Step 3b: 更新 `AGENT_HOOK_SYSTEM`（`src/hooks.ts`）**

把现有 `AGENT_HOOK_SYSTEM` 文案从「最后一条消息必须是 JSON {ok,reason}」改为指示调用 StructuredOutput 工具：

```ts
const AGENT_HOOK_SYSTEM = `你正在作为 deepcode 的 agent hook 运行一个核查子代理。完成核查后，你必须调用 ${STRUCTURED_OUTPUT_TOOL_NAME} 工具返回结论：\n- 通过：{"ok": true}\n- 不通过：{"ok": false, "reason": "原因"}\n不要把结论写成普通文本，必须经该工具返回。`
```

`src/hooks.ts` 顶部 import 加 `STRUCTURED_OUTPUT_TOOL_NAME`：

```ts
import { STRUCTURED_OUTPUT_TOOL_NAME } from './tools/structuredOutput.js'
```

> `parseHookEvalResult` 与 `execAgentHook` **不改**：runAgent 现保证返回合 schema 的 JSON 串（或兜底文本），现有解析 + fail-safe 完全适用。确认 `src/hooks.ts` 不会因 import `./tools/structuredOutput.js` 引入循环（structuredOutput.ts 只 import `./types.js` 类型 + zod 类型，不 import hooks.ts）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- test/hookRuntime.test.ts test/hooks.test.ts`
Expected: PASS（含原有用例无回归）

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: 干净

- [ ] **Step 6: 提交**

```bash
git add src/hookRuntime.ts src/hooks.ts test/hookRuntime.test.ts test/hooks.test.ts
git commit -m "feat(hooks): agent hook 用 StructuredOutput 强约束替代文本解析 (L-044 capstone)"
```

---

### Task 4: 全量闸门 + opus 终审 + 合并

**Files:** 无新增

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全绿（533 基线 + 本件新增）

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 干净

- [ ] **Step 3: 构建**

Run: `npm run build`
Expected: 干净

- [ ] **Step 4: opus 全量终审**

派 opus 子代理审整个 L-044 change set（structuredOutput 模块 + runSub 强约束 + capstone）。重点：① 强约束循环不死循环（重试上限 + fail-safe 兜底）；② 结构化重试与 subStopFired 配额隔离；③ 无 outputSchema 路径零回归；④ capstone runAgent 签名仍 `Promise<string>`、parseHookEvalResult 端零改、fail-safe 保留；⑤ 无循环依赖（structuredOutput→types 单向）；⑥ zod safeParse 校验语义对齐 CC 机制。

- [ ] **Step 5: `finishing-a-development-branch` 合 main**

合 main（no-ff）→ push origin。

---

## Self-Review

**1. Spec coverage：**
- StructuredOutput 工具工厂（zod 校验 + onValid 捕获）→ Task 1 ✅
- 常量（工具名 / 重试上限 5 / 提醒）→ Task 1 ✅
- `AgentDefinition.outputSchema` → Task 2 ✅
- runSub 强约束（注入工具 / 重试 ≤5 / 配额隔离 / 返回校验 JSON / 无 schema 零回归 / fail-safe 兜底）→ Task 2 ✅
- capstone：runAgent 强约束 + AGENT_HOOK_SYSTEM 文案 + 解析端零改 + fail-safe → Task 3 ✅
- 全量闸门 + opus 终审 + 合并 → Task 4 ✅
- YAGNI 边界（无 AJV / 无顶层 CLI / 无 attachment 类型 / 无 env / 不改引擎 / 不碰 TUI）→ spec/plan 头部声明 ✅

**2. Placeholder scan：** 各步骤均含完整代码。Task 3 Step 1 的 hooks.ts 补例标注「若已有等价断言则跳过」是适配既有测试的必要留白，非占位。

**3. Type consistency：**
- `STRUCTURED_OUTPUT_TOOL_NAME`/`MAX_STRUCTURED_OUTPUT_RETRIES`/`structuredOutputReminder`/`makeStructuredOutputTool(schema, onValid)` 在 Task 1 定义，Task 2/3 一致消费。
- `AgentDefinition.outputSchema?: z.ZodTypeAny`（Task 2）被 runSub（Task 2）消费。
- `HOOK_EVAL_SCHEMA = z.object({ok, reason?})`（Task 3）与 ①c `{ok,reason}` 契约 + `parseHookEvalResult` 一致。
- `HookEngineDeps.runAgent` 签名保持 `Promise<string>`（Task 3 不改类型，只改实现）。
