# L-044 结构化输出强约束（StructuredOutput）设计

**日期：** 2026-06-17
**机制：** 路线图 §B（`docs/specs/2026-06-16-cc-mechanisms-roadmap.md`）。依赖 ✅L-040 类型化子代理 + ✅L-042 hooks。
**对齐源：** CC `/Users/silas/Desktop/src/tools/SyntheticOutputTool/SyntheticOutputTool.ts` + `utils/hooks/hookHelpers.ts`(`registerStructuredOutputEnforcement`) + `utils/hooks/execAgentHook.ts` + `QueryEngine.ts`（重试上限）。两份实读报告已存档于会话。

---

## 1. 目标与价值

让子代理**可靠产出机器可解析的结构化结果**，而非自由文本父代理再正则。这是 L-045 fan-out 聚合的前提，也立刻用来**消除 ①c agent hook 的 `{ok,reason}` 文本解析近似**（hooks 系统现有偏差，L-042 ①c opus 终审记录的待办）。

## 2. CC 机制（实读结论，全保真对齐的是"机制"）

- **工具**：CC 工具名 `StructuredOutput`（内部类 `SyntheticOutputTool`）。`createSyntheticOutputTool(jsonSchema)` 用 **AJV** 编译校验器；`call(input)`：校验失败抛错（错误文本流回模型重试）、成功返回 `{ data, structured_output: input }`。结果经 toolExecution 抽出 `structured_output` 字段包成 `{type:'structured_output'}` attachment。
- **强约束**：`registerStructuredOutputEnforcement` 注册一个 **Stop function-hook**，回调 `hasSuccessfulToolCall(messages,'StructuredOutput')`——代理想结束时若历史里没有成功的 StructuredOutput 调用 → hook `blocking`，注入 `You MUST call the StructuredOutput tool…` 强制重试。
- **重试上限**：`MAX_STRUCTURED_OUTPUT_RETRIES`（默认 5）；超限 → `error_max_structured_output_retries` 终止。
- **hook-agent 也用它**：`execAgentHook` 给 hook 子代理注入一个**固定 `hookResponseSchema`（{ok,reason}）**的 StructuredOutput 工具，从 attachment 取校验对象——即 CC 的 agent hook 本就是结构化输出，deepcode ①c 用文本解析近似，本件补齐。

### 2.1 deepcode 的对齐取舍（机制对齐、宿主适配）

| 维度 | CC | deepcode | 理由 |
|---|---|---|---|
| schema 表示 | JSON Schema + AJV | **zod**（`safeParse`） | deepcode 工具系统 zod-native（`Tool.inputSchema: ZodTypeAny`、`loop.ts` `safeParse`、`zod-to-json-schema` 已在）。引入 AJV/JSON Schema 是逆宿主。机制（校验→错误流回→Stop 续跑）逐一对齐。 |
| 应用面 | 顶层 query（`--json-schema`）+ hook-agent | **子代理（`AgentDefinition.outputSchema`）+ agent-hook** | 路线图 §B 钦定子代理应用（为 L-045）。deepcode 无顶层 `--json-schema` CLI；等价落点是子代理与 agent-hook。 |
| 强约束载体 | 程序注册的 Stop **function-hook** | **runSub/runAgent 内联框架逻辑**（SubagentStop 生命周期点） | deepcode hooks 引擎是 settings 配置驱动（command/prompt/agent/http 四类型），**无运行时 function-hook 类型**。结构化输出强约束是**框架行为**（非用户配置 hook），内联在子循环结束点（=SubagentStop 时刻）最干净、零引擎改动。 |
| 结果回传 | `structured_output` attachment | 工具 `call` 经 `onValid` 回调捕获校验对象 → 子循环返回 `JSON.stringify(对象)` | deepcode `Tool.call` 返回 `string`，子代理结果也是 string（父代理拿 JSON 串）。回调捕获比翻消息历史干净。 |
| 工具名 | `StructuredOutput` | `StructuredOutput`（同名，对齐） | — |

## 3. 设计

### 3.1 共享原语 —— 新模块 `src/tools/structuredOutput.ts`

```ts
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from './types.js'

export const STRUCTURED_OUTPUT_TOOL_NAME = 'StructuredOutput'
export const MAX_STRUCTURED_OUTPUT_RETRIES = 5  // 对齐 CC MAX_STRUCTURED_OUTPUT_RETRIES

/** 强约束续跑提醒（子代理未调 StructuredOutput 就想结束时注入）。 */
export function structuredOutputReminder(): string {
  return `你必须调用 ${STRUCTURED_OUTPUT_TOOL_NAME} 工具，按要求的结构返回最终答案。现在就调用它。`
}

/** StructuredOutput 工具工厂：按给定 zod schema 校验入参，成功经 onValid 捕获。
 *  仅在声明了 outputSchema 的子代理/agent-hook 的工具池里动态注入（不进全局池）。 */
export function makeStructuredOutputTool(schema: z.ZodTypeAny, onValid: (value: unknown) => void): Tool<z.ZodTypeAny> {
  return {
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    description: '把你的最终答案按要求的结构化格式返回。在回复末尾必须且只调用一次本工具。',
    inputSchema: schema,         // API 层经 toApiTools→zodToJsonSchema 把 schema 作为工具 parameters 暴露给模型
    isReadOnly: true,
    needsPermission: () => false,
    async call(input) {
      // 注：loop.ts execCall 已对 inputSchema 做过 safeParse，能进到这里的 input 必合 schema。
      // 此处再 parse 一次取规范化值并捕获（防御 + 拿 zod 转换后的值）。
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

> **为何还需 onValid 捕获**：`loop.ts:execCall` 对任何工具入参先 `tool.inputSchema.safeParse`，不合则返回错误给模型（既有续跑机制天然覆盖"schema 不符→重试"）。但校验后的**对象本身**需要拿回——`call` 返回 string，故用 `onValid` 回调把规范化对象交给调用方（runSub/runAgent）。

### 3.2 `AgentDefinition.outputSchema`（`src/tools/agentTypes.ts`）

```ts
export interface AgentDefinition {
  agentType: string
  whenToUse: string
  tools?: string[]
  disallowedTools?: string[]
  model?: 'inherit' | string
  /** L-044：声明则强制子代理用 StructuredOutput 工具按此 schema 产出，结果取校验对象的 JSON（非自由文本）。 */
  outputSchema?: z.ZodTypeAny
  getSystemPrompt(): string
}
```

内建 3 个 agent 不加 outputSchema → 行为完全不变（向后兼容）。

### 3.3 runSub 强约束循环（`src/tools/agent.ts`）

在现有 `runSub` 的 `while(true)` 子循环里加结构化输出强约束，**位于既有 SubagentStop 用户 hook dispatch 之前**：

- 若 `def.outputSchema` 存在：
  - 子循环工具池追加 `makeStructuredOutputTool(def.outputSchema, v => { captured = v })`（`let captured: unknown` 在 runSub 作用域，`let structuredRetries = 0`）。
  - 每轮 runLoop 结束（子代理无工具调用想停）后：
    - `captured !== undefined`（本轮或之前轮已成功产出）→ 进入既有 SubagentStop 用户 hook 逻辑，最终 **返回 `JSON.stringify(captured)`**（而非 `final?.content`）。
    - `captured === undefined && structuredRetries < MAX_STRUCTURED_OUTPUT_RETRIES` → `structuredRetries++`、`messages.push({role:'user', content: structuredOutputReminder()})`、`continue`（再跑一轮，**不消耗 subStopFired**——结构化重试与用户 SubagentStop 续跑是两个独立配额）。
    - 超限 → 兜底 `return final?.content`（best-effort 自由文本，不死循环）。
- 无 `def.outputSchema` → 完全走现有路径（返回 `final?.content`）。

> **配额隔离**：结构化重试用独立 `structuredRetries`（≤5），不与用户 SubagentStop hook 的 `subStopFired`（限 1 次续跑）混用。先满足结构化输出，再跑用户 SubagentStop hook。

### 3.4 capstone：消除 ①c agent-hook `{ok,reason}` 文本解析（`src/hookRuntime.ts` + `src/hooks.ts`）

L-042 ①c 的 agent hook 现状：`hookRuntime.runAgent` 跑只读子代理 → 返回末条文本 → `hooks.ts:parseHookEvalResult` 文本 JSON 解析 `{ok,reason}`（opus 终审记录的近似）。本件用 §3.1 原语补齐：

- 定义 `HOOK_EVAL_SCHEMA = z.object({ ok: z.boolean(), reason: z.string().optional() })`（放 hooks.ts 或 hookRuntime.ts）。
- `hookRuntime.runAgent` 改为内联同样的强约束小循环：注入 `makeStructuredOutputTool(HOOK_EVAL_SCHEMA, …)`、≤5 次强制、**返回校验后的 `{ok,reason}` 对象**（签名从 `Promise<string>` 改 `Promise<{ok:boolean;reason?:string} | undefined>`，或返回 JSON 串由 execAgentHook 解析——见下取舍）。
- `hooks.ts:execAgentHook` 改为消费结构化对象而非 `parseHookEvalResult(text)`。
- **取舍（计划阶段定）**：为最小化签名改动，runAgent 可仍返回 `string`（= `JSON.stringify(captured)` 或末条文本兜底），execAgentHook 继续用 `parseHookEvalResult` 解析——这样**强约束在 runAgent 内保证产出合 schema 的 JSON 文本**，解析端零改。这是更小的改动，倾向采此。`HookEngineDeps.runAgent` 类型不变。

> capstone 是 L-044 的真实消费者与机制验证。若超时/重试耗尽仍无结构化输出，runAgent 回退末条文本 → `parseHookEvalResult` 仍按现有 fail-safe（解析失败→non_blocking_error 不 block）兜底，**绝不因结构化强约束把 agent hook 变成会卡死/误 block**。

## 4. 不做（YAGNI / 明确边界）

- **不引入 AJV / JSON Schema 运行时**：deepcode zod-native，§3.1 用 zod。
- **不加顶层 `--json-schema` CLI/headless 入口**：CC 有，但 deepcode 无对应 SDK 形态，路线图未要求；等真需求。
- **不加 `structured_output` attachment 消息类型**：deepcode 子代理结果是 string，用 `JSON.stringify(captured)` 回传即可，不新增消息类型（YAGNI）。
- **不加 `MAX_STRUCTURED_OUTPUT_RETRIES` 环境变量**：常量 5 足够（CC 有 env 覆盖，deepcode 暂不需要）。
- **不改 hooks 引擎**：强约束是框架逻辑，不进 settings 配置 hook、不加 function-hook 类型。
- **不碰 TUI**：纯逻辑，免真机冒烟。

## 5. 测试策略

- **`makeStructuredOutputTool`**：合 schema→onValid 收到规范化对象 + 返回成功串；不合 schema→返回错误串、onValid 不被调（注：execCall 层 safeParse 通常先拦，但工具自身也防御）。
- **runSub 强约束**（mock runLoop/hookDispatch，仿现有 agent 测试夹具）：① 无 outputSchema→行为不变（返回末条文本）；② 有 outputSchema 且子代理调了 StructuredOutput→返回 `JSON.stringify(对象)`；③ 有 outputSchema 但子代理首轮没调→注入提醒续跑，次轮调了→成功；④ 连续 5 轮不调→超限兜底返回文本（不死循环）；⑤ 结构化重试不消耗 subStopFired（与用户 SubagentStop 续跑配额独立）。
- **capstone agent-hook**：mock runAgent 注入 StructuredOutput 路径，断言 execAgentHook 拿到 `{ok:false,reason}`→blocking；超限回退文本→parseHookEvalResult fail-safe 不 block。
- **闸门**：全量 `npm test`+`typecheck`+`build` 全绿。纯逻辑免冒烟。架构件（structuredOutput 模块 + runSub 改造）末加 **opus 全量终审**。

## 6. 文件清单

- 新建 `src/tools/structuredOutput.ts`（工具工厂 + 常量 + 提醒）。
- 改 `src/tools/agentTypes.ts`（`AgentDefinition.outputSchema?`）。
- 改 `src/tools/agent.ts`（runSub 强约束循环）。
- 改 `src/hookRuntime.ts`（runAgent 强约束，capstone）。
- 改 `src/hooks.ts`（`HOOK_EVAL_SCHEMA`，execAgentHook 取舍：倾向解析端零改）。
- 测试：新建 `test/structuredOutput.test.ts`；扩 `test/agent*.test.ts`、`test/hookRuntime.test.ts`/`test/hooks.test.ts`。
