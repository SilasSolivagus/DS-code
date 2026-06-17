# L-040 B 用户自定义子代理（CC 生态兼容）设计

**日期：** 2026-06-17
**机制：** 路线图 §H（`docs/specs/2026-06-16-cc-mechanisms-roadmap.md`）。L-040 A（内建注册表）的延伸 B 阶段。
**对齐源：** CC `/Users/silas/Desktop/src/tools/AgentTool/loadAgentsDir.ts` + `utils/markdownConfigLoader.ts` + `utils/frontmatterParser.ts` + `builtInAgents.ts`。实读报告已存档于会话。
**用户钦定：** **和 CC 对齐、未来兼容 CC 生态**——现有 `.claude/agents/*.md` 文件能直接在 deepcode 加载并工作。

---

## 1. 目标

让用户/项目用 markdown 文件（`.claude/agents/*.md` + `.deepcode/agents/*.md`）自定义专才子代理，无需改代码。**CC 生态兼容 = 容忍解析全 CC frontmatter 键集**，honor deepcode 当前能支持的子集，其余字段**解析但 no-op**（随各子系统落地点亮），保证 CC 文件加载不报错且核心行为可用。

## 2. CC 机制（实读结论）

- **目录**（last-wins 覆盖序，低→高）：builtin < plugin < user(`~/.claude/agents/`) < project(`<proj>/.claude/agents/` 及上溯) < flag < managed。递归扫 `*.md`。
- **frontmatter**：`name`(必填→agentType)、`description`(必填→whenToUse，`\n` 反转义)、`tools`(逗号串/YAML 数组，`*`=全部，省略=全部，空=[])、`disallowedTools`(同)、`model`(inherit/sonnet/opus/haiku/id，大小写不敏感，仅 inherit 小写化)、`color`(8 色枚举)、进阶 effort/maxTurns/memory/isolation/mcpServers/hooks/skills/permissionMode/background/initialPrompt。body=systemPrompt(trim)。
- **容错**：缺 `name`→静默跳过（视作非 agent 文档）；缺 `description`→记错跳过；YAML 坏→重试一次再空。
- **合并**：`Map<agentType, def>` 按来源顺序遍历，后者覆盖前者（用户可覆盖内建）。

## 3. deepcode 现状

- `src/tools/agentTypes.ts`：`AgentDefinition`{agentType,whenToUse,tools?,disallowedTools?,model?,outputSchema?,getSystemPrompt()} + `BUILTIN_AGENTS`(general-purpose/Explore/Plan) + `resolveAgentTools`(deny 赢 allow) + `buildAgentDescription()`(读模块级 BUILTIN_AGENTS) + `formatAgentLine`。
- `src/tools/agent.ts:54` `BUILTIN_AGENTS.find(a => a.agentType === type)` 路由；`:48` `buildAgentDescription()` 拼工具描述；`:60` model 解析 `!model||inherit→getModel() : flash→SUB_MODEL : 字面`。
- `src/commands.ts:loadCustomCommands` 有「扫 `~/.deepcode/commands/`+`<proj>/.deepcode/commands/`、读 `*.md`、容错跳过」模式可照搬（但只读原文不解析 frontmatter）。
- **无 yaml 依赖、无 frontmatter 解析器**。模型双档：`SUB_MODEL='deepseek-v4-flash'`（cheap）、`deepseek-v4-pro`（主）。

## 4. 设计

### 4.1 依赖：加 `yaml`（用户钦定）

`package.json` deps 加 `yaml`（成熟、零传递依赖），用于忠实解析 frontmatter（YAML 数组/引号/多行/转义），最大化 CC 文件兼容。

### 4.2 目录与优先级（用户钦定双读）

扫描顺序（last-wins，低→高优先级）：
1. builtin（`BUILTIN_AGENTS`）
2. user `.claude`：`~/.claude/agents/*.md`
3. user `.deepcode`：`~/.deepcode/agents/*.md`
4. project `.claude`：`<cwd>/.claude/agents/*.md`
5. project `.deepcode`：`<cwd>/.deepcode/agents/*.md`

即 **project > user，同级 .deepcode > .claude，用户可覆盖内建**。**非递归**（各 agents 目录顶层 `*.md`，对齐 `loadCustomCommands` 的 flat 扫描；递归留后续，CC 文件惯例平铺）。managed/policy 层 deepcode 无对应设置基建，**不做**（YAGNI）。

### 4.3 新模块 `src/agentsLoader.ts`

纯函数 + I/O 加载，单测友好（home/cwd 可注入）。

```ts
// 1. frontmatter 解析（用 yaml 包）
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string }
//  - 文件以 `---\n` 开头：取到下一个 `\n---` 之间为 YAML，其后为 body；否则 data={}, body=raw。
//  - YAML 解析失败 → data={}（容错，对齐 CC「坏→空」）。

// 2. tools 字段解析（对齐 CC parseAgentToolsFromFrontmatter）
export function parseToolList(value: unknown): string[] | undefined
//  - undefined→undefined(全部)；string→逗号切 trim 非空；array→过滤 string；含 '*'→undefined(全部)；空→[]

// 3. model 别名映射（CC Anthropic 档 → deepcode 词汇 inherit/flash/字面）
export function resolveAgentModelAlias(model: unknown): string | undefined
//  - 非字符串/空 → undefined（= inherit 默认）
//  - 小写匹配：'inherit'→'inherit'；'haiku'→'flash'；'sonnet'|'opus'→'inherit'（deepcode 无对应强档，落父模型）
//  - 'claude-…' 等未知 Anthropic id → 'inherit'（deepcode 跑不了，兜底父模型，不把坏 id 喂 API）
//  - 'flash' / 'deepseek-…' / 其它 → 原样透传（deepcode 原生）

// 4. 单文件 → AgentDefinition | null（缺 name/description → null）
export function parseAgentFile(filename: string, raw: string): AgentDefinition | null
//  - agentType = frontmatter.name（必填，非空 string）；缺 → null（静默，视作非 agent 文档）
//  - whenToUse = String(description).replace(/\\n/g,'\n')（必填）；缺 → null
//  - tools=parseToolList(data.tools)；disallowedTools=parseToolList(data.disallowedTools)
//  - model=resolveAgentModelAlias(data.model)
//  - getSystemPrompt = () => body.trim()
//  - 进阶字段（memory/isolation/mcpServers/hooks/skills/permissionMode/effort/background/initialPrompt/color）解析层忽略（no-op，CC 文件仍加载）
//  - filename（不含 .md）仅当 frontmatter 无 name 时不兜底（对齐 CC：name 必填；不像 commands 用文件名）

// 5. 加载所有自定义 agent（I/O）
export function loadCustomAgents(cwd: string, home?: string): AgentDefinition[]
//  - 按 4.2 顺序遍历 4 个目录，readdirSync *.md，逐文件 readFileSync→parseAgentFile，非空收集。
//  - 目录不存在/文件坏 → 跳过（try/catch，对齐 loadCustomCommands）。

// 6. 合并（builtin + custom，后者覆盖同名）
export function mergeAgents(builtin: AgentDefinition[], custom: AgentDefinition[]): AgentDefinition[]
//  - Map<agentType,def>，先 builtin 后 custom 顺序 set，last-wins，返回 values。

// 7. 便捷：解析最终注册表
export function resolveAgents(cwd: string, home?: string): AgentDefinition[]
//  - mergeAgents(BUILTIN_AGENTS, loadCustomAgents(cwd, home))
```

### 4.4 接线：注册表贯穿（去模块级硬引用）

- `agentTypes.ts`：`buildAgentDescription()` → `buildAgentDescription(agents: AgentDefinition[])`（参数化，不再读模块级 BUILTIN_AGENTS）。
- `agent.ts`：`makeAgentTool(deps)` 的 `deps` 加 `agents?: AgentDefinition[]`（缺省 `BUILTIN_AGENTS`，保后向兼容/测试）。`description: buildAgentDescription(deps.agents ?? BUILTIN_AGENTS)`；路由 `(deps.agents ?? BUILTIN_AGENTS).find(a => a.agentType === type)`。
- 调用点（`useChat.ts`/`headless.ts` 构造 makeAgentTool 处）：启动时 `resolveAgents(cwd, home)` 一次，传 `agents`。**仅这两处**（hookRuntime.runAgent 不经 makeAgentTool，不涉及）。
- model 解析（agent.ts:60）**不改**：resolveAgentModelAlias 已在加载时把 model 归一到 deepcode 词汇（inherit/flash/字面），现有 `:60` 逻辑正确消费。

### 4.5 CC 生态兼容范例（必须能加载工作）

`~/.claude/agents/code-reviewer.md`：
```markdown
---
name: code-reviewer
description: Review code changes for bugs, style, and architecture concerns
tools: Read, Grep, Bash
model: sonnet
---
You are a code review specialist. Examine changes for correctness bugs, style, and architecture. For each issue give file:line, severity, and a fix.
```
→ deepcode 加载为 agentType=`code-reviewer`、whenToUse=description、tools=[Read,Grep,Bash]、model='inherit'(sonnet 映射)、systemPrompt=body。`/Agent subagent_type=code-reviewer` 即可路由。进阶字段（若有 memory/color 等）解析忽略不报错。

## 5. 不做（YAGNI / 边界）

- **不做 managed/policy 层**（deepcode 无受管设置基建）。
- **不做 plugin agents**（`pluginName:` 前缀，等插件系统）。
- **进阶字段不落地**：memory/isolation(→L-020)/mcpServers(→L-022)/hooks/skills/permissionMode/effort/background/initialPrompt——**解析时忽略**（不报错），随子系统点亮。
- **不做递归子目录扫描**（flat *.md；CC 文件惯例平铺，递归留后续）。
- **不加 agent 管理 UI / source 追踪 / color 渲染**（无 TUI 改动，纯逻辑免冒烟）。
- **不改安全边界**：`GLOBAL_SUBAGENT_DENY`（Edit/Write/Agent）仍兜底——CC 文件即便 `tools: Write` 也解析不到，可写等 L-020。

## 6. 测试策略

- **parseFrontmatter**：有/无 frontmatter、YAML 数组、引号、坏 YAML→空、`---` 边界。
- **parseToolList**：逗号串、数组、`*`→undefined、省略→undefined、空→[]。
- **resolveAgentModelAlias**：inherit/haiku→flash/sonnet|opus→inherit/claude-*→inherit/flash 透传/deepseek-id 透传/大小写。
- **parseAgentFile**：完整 CC 文件→AgentDefinition、缺 name→null、缺 description→null、body→systemPrompt、`\n` 反转义、进阶字段被忽略不崩。
- **loadCustomAgents**（注入 tmp home/cwd + mkdtemp 造 `.claude/agents`/`.deepcode/agents`）：四目录优先级、project>user、同级 .deepcode>.claude、目录不存在跳过。
- **mergeAgents**：custom 覆盖同名 builtin、新增、顺序。
- **接线**：`makeAgentTool({agents})` 路由到自定义 agent（脚本驱动 chatStream 夹具，仿现有 agent.test.ts）；`buildAgentDescription(agents)` 含自定义行。无 agents → 退回 BUILTIN_AGENTS 零回归。
- **闸门**：全量 `npm test`+`typecheck`+`build` 全绿。**纯逻辑非 TUI 免冒烟**。架构件（agentsLoader + 接线）末加 **opus 全量终审**。

## 7. 文件清单

- 新建 `src/agentsLoader.ts`（解析 + 加载 + 合并 + 别名映射）。
- 改 `src/tools/agentTypes.ts`（`buildAgentDescription` 参数化）。
- 改 `src/tools/agent.ts`（makeAgentTool deps.agents + 路由/描述用之）。
- 改 `src/tui/useChat.ts` + `src/headless.ts`（resolveAgents 一次、传 agents）。
- 改 `package.json`（加 `yaml`）。
- 测试：新建 `test/agentsLoader.test.ts`；扩 `test/agent.test.ts`、`test/agentTypes.test.ts`。
