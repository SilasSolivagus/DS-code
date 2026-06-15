# L-040 设计：子代理类型化（subagent typing，对齐 CC）

**日期：** 2026-06-15
**状态：** 已批（交互 brainstorm + CC 源码实读对齐）
**来源：** 编排层差距分析（`loop/BACKLOG.md` L-040）+ CC 源码实读 `/Users/silas/Desktop/src`

---

## 目标

把 deepcode 现有的**单一、写死、只读** Agent 子代理，升级为**类型化**子代理系统：`subagent_type` 参数 + 内建类型注册表，每类自带 system prompt / 工具集（allow/deny）/ 模型。1:1 对齐 CC 的 `AgentDefinition` + `resolveAgentTools` + 路由设计（只读子集；**可写子代理 = L-020**，本期不做）。

这是编排内核的**类型化挂载点**：L-020（可写+worktree）、L-041（后台任务）、L-044（结构化输出）、L-045（多 agent 工作流）都挂在它上。

## 非目标（本期不做）

- 可写子代理 / worktree 隔离（L-020）。
- 用户自定义 markdown agent（B 阶段，日后单独小 gap；本期只内建注册表）。
- CC 的 memory / hooks / mcpServers / effort / maxTurns / background / skills / isolation 字段。
- CC 专属内建类型：claude-code-guide、statusline-setup、verification。

---

## 架构

### 1. AgentDefinition（CC `BaseAgentDefinition` 的最小忠实子集）

新文件 `src/tools/agentTypes.ts`：

```ts
export interface AgentDefinition {
  agentType: string                    // 路由键
  whenToUse: string                    // 喂模型决定何时用（= CC 的 description）
  tools?: string[]                     // allow 列表；undefined 或 ['*'] = 通配（全池减 deny）
  disallowedTools?: string[]           // deny 列表
  model?: 'inherit' | string           // 省略 = 'inherit'（父当前模型）；可钉具体档（flash/pro）
  getSystemPrompt(): string            // 每类一段独立 prompt
}
```

砍掉 CC 其余字段（全是可写/高级特性或 token 优化，本期不需要）。

### 2. 内建类型注册表（3 个，全只读）

`src/tools/agentTypes.ts` 导出 `BUILTIN_AGENTS: AgentDefinition[]`，照搬 CC 配置（prompt 文本对齐 CC 的 READ-ONLY 约束 + deepcode 既有 `SUB_SYSTEM` 风格）：

| agentType | whenToUse | tools / disallowedTools | model | systemPrompt 要点 |
|---|---|---|---|---|
| `general-purpose` | 研究复杂问题、搜代码、执行多步任务；不确定能否一次命中时用它 | `tools: ['*']`（通配） | `inherit` | 宽泛研究助手；并行只读工具；简洁结构化回报（调用方会转述） |
| `Explore` | 快速只读搜代码/定位实现，指定 quick/medium/very thorough | `disallowedTools: ['Edit','Write','Agent']` | `flash`（对齐 CC 外部 haiku=最便宜档，省钱） | READ-ONLY 强约束 + Glob/Grep 指引；只定位不修改 |
| `Plan` | 软件架构师，出实施计划 | `disallowedTools: ['Edit','Write','Agent']` | `inherit` | READ-ONLY 探索 → 末尾「实施关键文件」清单 |

`general-purpose` 即**现有单一 Agent 的归位**（向后兼容：省略 `subagent_type` 默认它，行为不破）。

### 3. 工具解析（照搬 CC `resolveAgentTools` 三步）

新函数 `resolveAgentTools(def, allTools, globalDeny): Tool[]`（`agentTypes.ts`，纯函数可测）：

**规则一句话：deny 永远赢 allow；无 allow = 通配 = 全池减 deny。**

1. **基础池** = `allTools` 减去**全局子代理 deny**。
2. **类型 deny** = `def.disallowedTools` 再从池里减。
3. **allow 解析**：
   - `def.tools` 为 `undefined` 或 `['*']` → **通配**：结果 = 步骤 2 的池（全池减两层 deny）。
   - 否则逐个在「已减 deny 的池」里查名，命中入结果，未命中忽略（可 log）。

**全局子代理 deny（本期，关键安全边界）= `['Edit','Write','Agent']`**：
- 保证「可写 = L-020」：连 `general-purpose ['*']` 也解析不到 Edit/Write。
- 排除 `Agent`：子代理不能再派子代理（避免无限递归 / 失控扇出）。
- **Bash 不在全局 deny**（用户选 B，贴 CC）：general-purpose 通配 → 拿到 Bash/WebFetch/Read/Glob/Grep/TodoWrite。
- L-020 落地时从全局 deny 移除 Edit/Write（给 worktree 隔离的可写类型）。

### 4. 子代理 Bash 策略（用户选 B 的安全适配）

子代理上下文**无权限弹窗 UI**（没有人可问）。子代理内 Bash 走 **yolo + 钳制**：
- 非危险命令（`isDangerous` 为否）→ 自动放行执行。
- 危险命令（`isDangerous` 为真，如 `rm -rf`、`sudo` 等既有判定）→ **拒绝执行**，把「危险命令在子代理中被拒，请改用更安全的方式或交由主会话」作为 tool_result 返回给子代理（不崩、不静默成功）。
- 实现：子代理的 `ToolContext` 注入一个 `permissionMode: 'subagent'`（或等价标志），`checkPermission` 对 Bash 走「safe→allow / dangerous→deny」分支。复用现有 `isDangerous`。

### 5. 路由（对齐 CC）

改 `src/tools/agent.ts` 的 `makeAgentTool`：
- 入参 schema 加 `subagent_type?: string`（自由字符串、optional、描述「专才类型」）。
- 省略 → 默认 `'general-purpose'`。
- 解析：在 `BUILTIN_AGENTS` 里按 `agentType` 找；**未知 → 抛** `Agent type 'X' not found. Available: <逗号分隔类型名>`。
- 找到后：用该类型的 `getSystemPrompt()` 作子代理系统提示、`resolveAgentTools(...)` 作子代理工具集、`model`（inherit→父当前模型，否则钉档）。
- **工具描述动态枚举**（CC `formatAgentLine` 口径）：Agent 工具的 `description` 末尾列出可用类型 `- {agentType}: {whenToUse} (Tools: {toolsDesc})`，`toolsDesc` = 仅 deny→`All tools except X,Y`；仅 allow→列出；都无→`All tools`。末加「省略 subagent_type 则用 general-purpose」。

### 6. 模型映射（CC inherit/haiku → deepcode inherit/flash）

`model?` 优先级：工具传参（若加）> 类型定义 `model` > 默认 `'inherit'`。
- `'inherit'` → 父当前模型（deepcode 主会话的 `model`，flash 或 pro）。当前 deepcode 子代理恒用 `SUB_MODEL=flash`；**对齐 CC 改为 inherit 语义**，Explore 显式钉 `flash`（省钱、对齐 CC 外部 haiku）。
- 实现：`makeAgentTool` 已能拿到主会话 model；inherit 时透传。

### 7. 结果回传：不变

最后一条 assistant text 作结果（CC 同款）。Explore/Plan 是 one-shot 检索/规划，可省 trailer（本期可不做 trailer 优化，保持现状即可）。

---

## 改动文件

| 文件 | 改动 |
|---|---|
| `src/tools/agentTypes.ts`（新） | `AgentDefinition` 接口 + `BUILTIN_AGENTS` 注册表（3 类型 + 各自 getSystemPrompt）+ 纯函数 `resolveAgentTools` |
| `src/tools/agent.ts` | `makeAgentTool`：加 `subagent_type` 路由 + 用类型的 prompt/tools/model + 动态工具描述；现有 `SUB_SYSTEM` 迁入 general-purpose |
| `src/tools/types.ts` | `ToolContext` 加子代理 Bash 策略标志（如 `subagentBash?: boolean` 或复用 permissionMode） |
| `src/permissions.ts` 或 `agent.ts` | 子代理 Bash 的 yolo+钳制判定（复用 `isDangerous`） |
| `src/tools/constants.ts` | `SUB_MODEL` 语义调整（inherit 默认；Explore 钉 flash） |

**契约不变**：主 loop `runLoop`、headless、只读工具、QuestionDialog 等不动。`makeAgentTool` 的对外签名（被 useChat 注入）尽量兼容。

## 测试策略

- `resolveAgentTools` 纯函数全单测：通配（undefined/`['*']`）、全局 deny 生效、类型 deny 叠加、allow 列表查名、Edit/Write/Agent 恒被排除、Bash 在 general-purpose 在场、Explore 不含 Edit/Write。
- 子代理 Bash 策略单测：safe→allow、dangerous→deny 返回错误文本。
- 路由单测：默认 general-purpose、未知类型抛错含 Available、各类型解析出正确工具集/prompt/model。
- 动态工具描述单测：三类型的 `(Tools: ...)` 文案口径。
- 回归：现有 agent 测试（单一只读行为）= general-purpose 归位后仍绿。

## 已知接受风险

| 风险 | 说明 |
|---|---|
| 子代理 Bash 无人审批 | 用户选 B；靠 yolo+`isDangerous` 钳制兜底；危险命令拒绝而非放行 |
| `isDangerous` 取前两词的粗判 | 既有局限（见项目史）；可接受，L-020/后续细化 |
| model inherit 改变子代理成本 | Explore 钉 flash 省钱；general-purpose/Plan inherit 可能用 pro（更贵但更准），调用方可控 |

## 带入

L-040 是地基。落地后 L-020（可写+worktree，从全局 deny 移除 Edit/Write + 加 implementer 类型 + isolation）、L-041（后台任务，AgentDefinition 加 background）、L-044（结构化输出，加 schema 字段）、L-045（多 agent）依次挂载。
