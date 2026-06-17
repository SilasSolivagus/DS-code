# deepcode Skills（技能）机制设计 spec

**日期：** 2026-06-17
**机制：** master roadmap 第 1 层 #1.2 Skills（闭合 L-040B frontmatter 的 `skills` 字段缺口）
**对齐依据：** CC 源码 skills 机制逐符号实读报告（`commands/SkillTool.ts`、`utils/loadSkillsDir.ts`、`utils/frontmatterParser.ts`、`types/command.ts`）。用户钦定「对齐 CC、别自创」。
**前置：** L-040B 自定义 agent 加载（`agentsLoader.ts` 的 `parseFrontmatter`/`parseToolList`/`resolveAgentModelAlias` 可复用）；L-044 结构化输出（forked skill 可带 outputSchema）。
**独立第二意见：** opus 架构 agent 实读代码后推翻了 inline 的「`<skill-instructions>` 包裹 + 改 prompt 守则」方案（注入面真实可利用，已核验 loop.ts:117/262/256 裸字符串拼接属实），改采方案 C（激活信号 + user 通道注入）。codex 当时撞 usage limit 未参与。
**TUI：** 是（轻量真机冒烟）。核心（loader + Skill 工具 + forked 抽取）纯逻辑；但 inline 注入改 loop.ts 回灌点、`/skill` 复用 useChat 斜杠分发，故本件末做一次真机 `npm start` 冒烟（`/skill` 与模型调 Skill 工具各往返一次），与 MCP 件同规格。

---

## 1. 目标与范围

让 deepcode 支持 CC 式 skills：从目录发现带 frontmatter 的 `SKILL.md`，把 skill 清单注入 system prompt 供模型择机调用，模型经**单个** `Skill` 工具调用，用户也能敲 `/<skill>` 调用；调用后 inline（正文作为指令注入对话）或 forked（子代理跑）执行。统一现有 `commands.ts` 的 `/cmd` 系统（作为 legacy user-only skill 向后兼容）。

### 用户钦定的四个设计决策（brainstorming 已拍板）
1. **暴露方式**：单 `Skill` 工具 + skill 清单注入 system prompt（对齐 CC，非「每 skill 一工具」）。
2. **执行语义**：inline + forked 两种都做。
3. **与 /cmd**：统一——新 skills 扫 `SKILL.md`（带 frontmatter、user+model 双调用），旧 `.deepcode/commands/*.md` 仍加载当 legacy user-only inline skill。
4. **目录格式**：四目录 + `<name>/SKILL.md` 目录格式（对齐 CC）。

### MVP 做（核心闭环）
1. **发现 + 解析**（`skillsLoader.ts` 新建）：扫四个 skills 目录的 `<name>/SKILL.md` + 两个 legacy commands 目录的 `*.md`，解析 frontmatter → `SkillDefinition[]`。
2. **单 Skill 工具**（`tools/skill.ts` 新建）：input `{skill, args?}`，校验 → inline（方案 C 激活信号）/ forked（共享 runner）。
3. **runSub 抽取**（`subagentRunner.ts` 新建）：把 `agent.ts` 的 `runSub` 闭包 + 并发信号量下沉为共享模块，Agent 工具与 forked skill 共用同一信号量（防 4→8 翻倍）。
4. **inline 注入（方案 C）**：Skill 工具 `call()` 返回激活信号 → loop.ts 在 tool_result 回灌后把 SKILL.md 正文（参数替换后）作为 `{role:'user'}` 注入。`/skill` 斜杠路径天然经 runTurn 注入 user 消息，与之汇合。
5. **清单注入**（`prompt.ts`）：`buildSystemPrompt` 末尾追加 skill 清单（会话启动静态，保 KV 缓存）。
6. **参数替换**：`$ARGUMENTS`（legacy 向后兼容）+ `$ARG1`/`$ARG2`（frontmatter arguments）+ `${DEEPCODE_SKILL_DIR}` + `${DEEPCODE_SESSION_ID}`。
7. **可见性**：默认双可调用；frontmatter `user-invocable:false` / `disable-model-invocation:true` 各禁一路。
8. **接线**：useChat（Skill 工具注入 + `/skill` 分发改造 + 清单）、headless（Skill 工具注入 + 清单）、agent.ts（子代理池可选注入只读 skill）、loop.ts（inline 注入点）。

### MVP 不做（对齐报告明确可砍，记入后续增量）
- **allowed-tools inline 收窄**：inline 模式下工具 `call()` 改不了后续轮次权限 → MVP 仅解析保留，inline 不强制收窄；forked 模式可用（子代理工具集按 allowedTools 收窄）。记为偏离。
- **内联 shell 执行**（CC 的 `` !`...` `` / ` ```! ` 块）：安全敏感，砍，留 follow-up。
- **plugin / bundled / MCP / remote skills**：本件只做本地目录 skill。plugin 命名空间（`plugin:skill`）不解析。
- **paths 条件激活**（按文件 glob 动态点亮 skill）：解析保留字段，MVP 不实现激活逻辑。
- **skill hooks**（frontmatter `hooks` + `once`/`onHookSuccess`→`removeSessionHook`）：解析忽略不崩；闭合 hooks.ts:26 留的 `once` 字段是独立增量。
- **清单 char 预算管理**（CC 的 8000 字符截断/优先级分配）：MVP 直接全列（deepcode 本地 skill 数量小）；超量截断留 follow-up。
- **skill 内容 compaction 保留**（CC `addInvokedSkill`）：MVP 不做；inline 正文已在对话历史里，随常规 compaction 处理。

---

## 2. 数据结构：`SkillDefinition`

```ts
// src/tools/skillTypes.ts（新建，或并入 skillsLoader.ts）
export interface SkillDefinition {
  name: string                    // 目录名（skills/）或文件名（commands/）；frontmatter name 可覆盖
  description: string             // 清单展示 + Skill 工具决策依据
  whenToUse?: string              // frontmatter when-to-use（清单 "name: desc - whenToUse"）
  context: 'inline' | 'fork'      // 默认 'inline'
  agent?: string                  // fork 时的 agent type（缺省 'general-purpose'）
  allowedTools?: string[]         // 解析保留；inline 不收窄（偏离），fork 收窄子代理工具集
  model?: string                  // resolveAgentModelAlias 复用（fork 时用）
  userInvocable: boolean          // 默认 true；frontmatter user-invocable:false 关
  modelInvocable: boolean         // 默认 true；frontmatter disable-model-invocation:true 关
  argNames?: string[]             // frontmatter arguments（$ARG1/$ARG2 命名）
  skillDir: string                // ${DEEPCODE_SKILL_DIR} 替换源（skill 所在目录绝对路径）
  isLegacy: boolean               // 来自 commands/ 目录（无 frontmatter、user-only、$ARGUMENTS）
  body: string                    // SKILL.md 正文（frontmatter 之后）/ commands 全文
}
```

合并语义：`Map<name>` 按发现序 set，last-wins（skill 覆盖同名 legacy command）。

---

## 3. 模块设计

### 3.1 `src/skillsLoader.ts`（新建，复用 agentsLoader 模式）

```
parseSkillFile(raw, skillDir): SkillDefinition | null
  - 复用 parseFrontmatter(raw)（agentsLoader 导出）
  - name = frontmatter.name ?? 目录名；description 缺 → 取正文首非空行（对齐 CC 默认）
  - context: 'fork' 仅当 frontmatter.context === 'fork'，否则 'inline'
  - userInvocable = frontmatter['user-invocable'] !== false（字符串 'false' 也算）
  - modelInvocable = frontmatter['disable-model-invocation'] !== true
  - allowedTools = parseToolList(frontmatter['allowed-tools'])（复用）
  - model = resolveAgentModelAlias(frontmatter.model)（复用）
  - argNames = parseToolList(frontmatter.arguments)
  - isLegacy = false

loadSkillsFromDir(dir): SkillDefinition[]        // 扫 <dir>/<name>/SKILL.md
loadLegacyCommands(dir): SkillDefinition[]       // 扫 <dir>/*.md → isLegacy=true, user-only
  - userInvocable=true, modelInvocable=false, context='inline', body=全文
  - 复用现有 commands.ts 的扫描语义（不破坏现有用户命令）

loadSkills(cwd, home=os.homedir()): SkillDefinition[]
  目录序（低→高优先，last-wins）：
    home/.deepcode/commands  (legacy)
    cwd/.deepcode/commands   (legacy)
    home/.claude/skills
    home/.deepcode/skills
    cwd/.claude/skills
    cwd/.deepcode/skills
  - 容错：目录不存在/单文件坏 → 跳过（对齐 loadCustomAgents）
  - 同名后者覆盖前者（skill > legacy command；project > user；.deepcode > .claude）
```

### 3.2 `src/subagentRunner.ts`（新建，从 agent.ts 抽取）

把 `agent.ts:31-42` 的并发信号量（`MAX_ACTIVE`/`active`/`waiters`/`acquire`/`release`）和 `agent.ts:67-137` 的 `runSub` 闭包下沉为共享模块。**关键（专家指出的致命陷阱）**：信号量必须是此模块的**单一实例**，agent.ts 和 skill.ts 都从这里 import，绝不复制——否则 4 并发上限静默变 8。

```ts
export async function acquire(): Promise<void>   // 模块级单例信号量
export function release(): void

export interface RunSubagentOpts {
  client: OpenAI; onUsage: (u: Usage, model: string) => void
  systemPrompt: string; userPrompt: string
  tools: Tool<any>[]; model: string
  outputSchema?: z.ZodTypeAny
  ctx: ToolContext; signal: AbortSignal
  agentId: string; agentType: string
  startContext?: string                          // 注入前缀（forked skill 用：skill 正文做行为定义）
}
export async function runSubagent(opts: RunSubagentOpts): Promise<string | undefined>
  // = 现 runSub 函数体，闭包捕获变量改为显式参数。
  // hook(SubagentStart/Stop)、结构化输出（captured/structuredRetries/subStopFired）皆局部变量，语义不变。
```

`agent.ts` 改为 import `acquire`/`release`/`runSubagent`，`makeAgentTool` 把 def/input/ctx/deps 映射成 `RunSubagentOpts`。**回归门**：抽取后 `npm test` 全绿（agent 现有测试零回归是合并前提）。

### 3.3 `src/tools/skill.ts`（新建）

```ts
export function makeSkillTool(
  skills: SkillDefinition[],
  deps: { client, onUsage, getModel, agents, skillPool },   // skillPool=forked 子代理可用工具池 = agent.ts 同款（allTools + WebFetch），由 resolveAgentTools 按 agent def + skill.allowedTools 收窄
): Tool<typeof schema>
```

- `name: 'Skill'`，`isReadOnly: true`（激活信号无副作用；forked 子代理自带权限钳制），`needsPermission: () => false`。
- input schema `{ skill: z.string(), args: z.string().optional() }`。
- `description`：列出可调用 skill（仅 `modelInvocable`），说明「调用后会把该 skill 的指令以独立消息交付给你，按其执行」。
- `call(input, ctx)`：
  1. 查 `skills.find(s => s.name === input.skill && s.modelInvocable)`；缺 → 抛错列出可用。
  2. 正文参数替换：`substituteSkillArgs(body, args, argNames, skillDir, ctx.sessionId)`。
  3. **inline**（方案 C）：调用 `ctx.injectUserMessage(替换后正文)`（见 §4），`call()` 返回简短激活回执（如 `已激活 skill 'x'，指令见下条消息`）。
  4. **forked**：构造 `RunSubagentOpts`（systemPrompt=skill 正文 / userPrompt=args，tools=skillPool 按 allowedTools 收窄，model 解析），`await acquire()` → `runSubagent` → `release()`，返回子代理结果作 tool_result。

### 3.4 参数替换 `substituteSkillArgs`（skillsLoader.ts 或 skill.ts 纯函数）

```
$ARGUMENTS          → args 全文（legacy 向后兼容）
$ARG1/$ARG2/...     → args 按空白切分的第 i 段（frontmatter arguments 命名时也支持 $<name>）
${DEEPCODE_SKILL_DIR}    → skillDir
${DEEPCODE_SESSION_ID}   → ctx.sessionId?.() ?? ''
```
（对齐 CC 的 `$ARG1`/`${CLAUDE_SKILL_DIR}`/`${CLAUDE_SESSION_ID}`，前缀换 deepcode 词汇。）

### 3.5 `src/prompt.ts` 清单注入

`buildSystemPrompt(cwd, home, skills?)` 末尾追加（仅当 skills 非空）：
```
# 可用技能（Skills）
你可以用 Skill 工具调用以下技能（也可在对话中按需触发）：
- <name>：<description>[ — <whenToUse>]
...
```
**静态性**：skills 在会话启动时 `loadSkills` 一次性解析（与 agents 同生命周期），清单整个会话不变 → 不破坏 KV 缓存前提（prompt.ts:27 注释）。只列 `modelInvocable` 的 skill。

---

## 4. inline 注入机制（方案 C 细节）

**约束**：`Tool.call()` 只能返回 string（tool_result），无法注入 user 消息（types.ts:36）。直接把正文作 tool_result 会撞 prompt.ts:38「工具结果非指令」防御；给该守则开 `<skill-instructions>` 例外则制造可被恶意文件内容伪造的注入面（专家核验：loop.ts:117/262 裸字符串拼接 + loop.ts:256 tool_result 原样回灌，伪造闭合标签可行）。

**方案 C**：经 `ToolContext` 加一个可选注入回调，不改 `Tool.call` 签名、不动 prompt.ts:38、不动静态 system prompt。

```ts
// types.ts ToolContext 增加：
injectUserMessage?: (content: string) => void   // 把内容排进待注入队列
```

- **loop.ts**：维护一个 turn 级 `pendingInjections: string[]`，`injectUserMessage` push 进去；在 tool_result 回灌（loop.ts:256）**之后**，把队列内容各作 `{ role: 'user', content }` push，然后清空。这样 skill 正文以 user 身份进对话（= CC meta user message 语义），模型按既有「user 消息即指令」对待，**无需任何信任边界例外**。
- **useChat / headless**：构造 ToolContext 时传入 `injectUserMessage`（指向各自的注入实现；headless 单发场景同样支持）。
- **`/skill` 斜杠路径**（useChat:716-735 改造）：查到 skill → 参数替换正文 → 作为 user 消息经 `runTurn` 发送（现有 `/cmd` 已是此形态，天然对齐，零信任边界改动）。inline skill 的两条入口（模型调 / 用户敲）汇合到「正文作 user 消息」这一语义。

**注入点细节**：`pendingInjections` 在 loop turn 内、tool_result 之后 flush，确保模型下一轮先看到激活回执（tool）再看到正文（user），顺序自然。多个 Skill 工具同 turn 调用 → 按调用序注入。

---

## 5. 接线地图

| 文件 | 改动 |
|---|---|
| `src/skillsLoader.ts` | 新建：发现 + 解析 + 合并 |
| `src/tools/skillTypes.ts` | 新建：`SkillDefinition`（或并入 loader） |
| `src/subagentRunner.ts` | 新建：抽取 runSub + 信号量下沉 |
| `src/tools/skill.ts` | 新建：`makeSkillTool` |
| `src/tools/agent.ts` | 改：import 共享 `acquire`/`release`/`runSubagent`，`makeAgentTool` 映射 opts；删本地信号量+runSub 闭包 |
| `src/tools/types.ts` | 改：`ToolContext.injectUserMessage?` |
| `src/loop.ts` | 改：`pendingInjections` 队列 + tool_result 回灌后 flush（约 :256） |
| `src/prompt.ts` | 改：`buildSystemPrompt` 加 skills 参数 + 清单注入 |
| `src/tui/useChat.ts` | 改：`loadSkills` + Skill 工具注入 tools 数组 + `/skill` 分发改造 + `injectUserMessage` + 清单传 buildSystemPrompt + suggest 补全 skill 名 |
| `src/headless.ts` | 改：`loadSkills` + Skill 工具注入 + `injectUserMessage` + 清单 |
| `src/tui/suggest.ts` | 改：`/` 自动补全合并 skill 名（现读 customCommands） |

---

## 6. 安全边界

- **inline 不开信任例外**：方案 C 让正文走 user 通道，prompt.ts:38 原封不动。skill 来自用户自己装的目录（`~/.claude/skills` 等），信任级别 = 用户输入，以 user 消息身份注入语义正确。
- **forked 子代理沿用现有钳制**：`subagentPermissionDecision`（安全命令放行/危险命令拒绝）+ `GLOBAL_SUBAGENT_DENY`（Edit/Write/Agent 兜底）。skill `allowedTools` 只能在此基础上**收窄**，不能提权。
- **model 别名白名单**：复用 `resolveAgentModelAlias`，绝不把跑不了的外部 model id 喂 DeepSeek API。
- **legacy command 默认 user-only**：旧 `.deepcode/commands/*.md` 无 frontmatter → `modelInvocable=false`，不进模型清单，行为与现状一致（不把现有纯文本命令暴露给模型自动调用）。

---

## 7. 测试计划（TDD）

- `skillsLoader`：frontmatter 解析（name 覆盖/默认、context/可见性/allowedTools/argNames）、四目录 + legacy 扫描、优先级 last-wins、容错（坏文件/缺目录）、description 缺省取正文首行。
- `substituteSkillArgs`：$ARGUMENTS / $ARG1.. / ${DEEPCODE_SKILL_DIR} / ${DEEPCODE_SESSION_ID}。
- `subagentRunner`：抽取后 runSubagent 行为等价（hook 注入、结构化输出、stop 续跑、abort）；**信号量单例**（agent + skill 两路共享，并发不超 4，关键回归测试）。
- `skill` 工具：inline 调 `injectUserMessage`（mock ctx 验证队列）+ 返回激活回执；forked 走 runSubagent；缺 skill 抛错；modelInvocable=false 的 skill 不可被 model 调；allowedTools 收窄 forked 工具集。
- `loop`：`injectUserMessage` push → tool_result 回灌后 flush 成 user 消息（顺序 + 多条）。
- `prompt`：清单注入只列 modelInvocable，空 skills 不加节，静态性。
- `agent.ts` 现有测试零回归（抽取门）。

---

## 8. 记录偏离（宿主受限/MVP 取舍，对齐 CC 但不全保真处）

1. **inline allowedTools 不收窄**：deepcode 工具 `call()` 改不了后续轮次权限。CC inline 经 contextModifier 临时收窄；deepcode MVP 仅解析保留。forked 路径可收窄。后续若做 loop 级权限上下文修改器再补。
2. **inline 经 ctx 注入回调而非真 meta message 字段**：方案 C 用 `ToolContext.injectUserMessage` + loop flush 实现，语义等价 CC meta user message，但不是改 `Tool.call` 返回多消息（方案 B）。收敛实现，侵入更小。
3. **内联 shell 执行砍掉**：CC skill 正文支持 `` !`cmd` ``；deepcode 安全敏感，不做。
4. **清单无 char 预算**：CC 8000 字符截断 + 优先级；deepcode 本地 skill 量小，全列，超量留 follow-up。
5. **plugin/bundled/MCP/remote skills、paths 激活、skill hooks、compaction 保留**：全留后续增量（见 §1 不做清单）。

---

## 9. 执行流程（照既定流程）

writing-plans 出 bite-sized TDD 计划 → subagent-driven-development 每任务 implementer + 独立审查双门 → 架构件（subagentRunner 抽取、loop 注入、skill 工具）加 opus 全量终审 → 本件末真机 `npm start` 冒烟（`/skill` 与模型调 Skill 工具各往返）→ finishing-a-development-branch 合 main。合并前全量 test + typecheck + build 全绿。
