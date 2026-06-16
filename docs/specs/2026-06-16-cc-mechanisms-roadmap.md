# deepcode 升级路线图：补齐 CC 机制（skill / mcp / hook / 编排 loop）

**日期：** 2026-06-16
**用途：** 新会话从这里起步——挑一个机制，按「既定流程」走 brainstorm→spec→实现。每项标了：CC 怎么做、deepcode 现状、**怎么加（具体入口）**、规模、依赖。
**配套台账：** `loop/BACKLOG.md`「编排层差距」段（L-020~L-046）。

---

## 既定流程（已验证三遍：M7②/L-040/L-041，照搬即可）

1. **对齐 CC**：派 agent 实读 CC 源码 `/Users/silas/Desktop/src`（编译前 TS 源码，可逐符号确证），拿回精确机制。**用户钦定"对齐 CC"，别自己发明。**
2. **brainstorm**（`superpowers:brainstorming`）→ 写 spec 到 `docs/specs/YYYY-MM-DD-<topic>-design.md`。需求模糊时问用户；用户说"对齐 CC"时直接读源码出对齐设计。
3. **writing-plans** → bite-sized TDD 计划 `docs/plans/`。
4. **subagent-driven**：每任务 implementer + 独立审查（双门）；架构件末加 **opus 全量终审**。
5. **TUI 闸**：碰 `src/tui/` 渲染/输入/有可见自主行为的 → 用户真机 `npm start` 冒烟（我看不见界面）。非 TUI（纯逻辑/工具/loop）→ 测试+审查即可合。
6. `finishing-a-development-branch` 合 main → bump/tag/push（npm 发布需用户 OTP）。

**质量标准**：每件入 main 前全量 `npm test` + `npm run typecheck` + `npm run build` 全绿。

---

## 已就位的地基（决定下面哪些能做）

- ✅ **L-040 类型化子代理**：`AgentDefinition` + `subagent_type` 路由 + `resolveAgentTools`（deny 赢 allow）+ 内建注册表。挂载点：加 `isolation`/`background`/`schema`/`tools` 字段即扩展。
- ✅ **L-041 后台任务**：`src/tasks.ts` 任务表 + 通知队列（模块级，`notified` 去重）+ `run_in_background` + `<task-notification>` 注入 + idle 唤醒 + TaskList/Output/Stop。挂载点：任务携 `abortController`/`pendingMessages` 即接 steering。
- ✅ 回合内并行只读工具（`loop.ts` CONCURRENCY=5）、权限系统、compact、TodoWrite、WebFetch、AskUserQuestion、/rewind。

---

## 机制清单（按"可做性 × 价值"排序）

### A. Hooks 生命周期（L-042）— M，无依赖，**建议先做**
- **CC**：`utils/hooks.ts` + `services/tools/toolHooks.ts`。事件集大（PreToolUse/PostToolUse/PostToolUseFailure/SubagentStop/SessionStart/Stop/PreCompact…）。`executePreToolHooks()` 在权限检查后、`tool.call()` 前；`executePostToolHooks()` 成功后。配置在 settings.json，hook 跑 shell 命令、可拦截/改写。
- **deepcode 现状**：**无**。`src/loop.ts:execCall` 是 `checkPermission → tool.call` 硬路径，无可插拔点。已有的 `reminders()`（回合末注入文本）是远亲。
- **怎么加**：① `src/hooks.ts`：定义事件类型 + `runHooks(event, payload)`（读 settings.hooks，spawn 配置的 shell，超时/容错）。② `execCall` 在 `checkPermission` 后插 `PreToolUse`（hook 可返回 deny/修改 input）、`tool.call` 后插 `PostToolUse`。③ `src/config.ts` Settings 加 `hooks` 字段。④ 子代理 Stop → SubagentStop 事件。
- **价值**：本身偏策略层，但**是 L-044 结构化输出的底座**（CC 用 Stop hook 实现）。先有它，L-044 才好做。

### B. 结构化输出强约束（L-044）— M，依赖 A(hooks)
- **CC**：`SyntheticOutputTool` + `registerStructuredOutputEnforcement()`（`utils/hooks/hookHelpers.ts`）。给子代理带 `jsonSchema` 时注册 Stop hook，强制子代理结束前调 SyntheticOutputTool 产出符合 schema 的 JSON，否则重试。
- **deepcode 现状**：子代理回传纯文本（`agent.ts` 最后一条 assistant）。父代理只能文本解析。
- **怎么加**：① `AgentDefinition`/Agent schema 加可选 `outputSchema`。② 子代理工具池注入一个 `SyntheticOutput` 工具（zod 校验入参）。③ 用 A 的 SubagentStop hook：若声明了 schema 但没调 SyntheticOutput → 退回让子代理重试（超次失败）。④ 子代理结果取 SyntheticOutput 的校验对象而非自由文本。
- **价值**：fan-out 聚合（L-045）的前提；让"把子任务结果可靠喂回编排逻辑"成立。

### C. 子代理 steering / 续聊（L-043）— L，依赖 ✅L-041
- **CC**：`tasks/InProcessTeammateTask/` 长生命周期可寻址 agent（`agentId`），`injectUserMessageToTeammate()` 把消息排进 `pendingUserMessages`，回合边界投递；`SendMessageTool` 按 `to:` 路由；停掉的 agent 用 `resumeAgentBackground()` 带注入消息续跑。
- **deepcode 现状**：子代理一次性纯函数、不可寻址；主 loop busy 拒输入（仅 Esc 全中断）。但 **L-041 已给后台 agent 任务句柄 + abortController**。
- **怎么加**：① 后台 agent 的 `BackgroundTask` 加 `pendingMessages: string[]`。② `SendMessage` 工具（`{to: taskId, message}`）→ push 进该任务 pendingMessages。③ 子代理子循环（`agent.ts` runSub）在回合边界检查并消费 pendingMessages（注入为 user 消息）。④ 主 loop steering：可选，让 busy 时用户输入排队而非丢弃。
- **价值**：长任务中途纠偏。建在 L-041 后台任务上。

### D. 多 agent 工作流（L-045）— L，依赖 ✅L-040 + ✅L-041 + C(L-043)，**最后做**
- **CC**：`TeamCreate` 建命名 swarm（lead + members）+ 任务依赖图（TaskUpdate 的 blocks/blockedBy）+ `SendMessage` + `local_workflow`。
- **deepcode 现状**：只能一回合并行发多个只读 Agent（fan-out 最弱形态）。
- **怎么加**：地基齐了才做——类型化 agent（✅）+ 后台任务（✅）+ steering（C）+ 结构化输出（B）之上加：team 概念、成员寻址、任务依赖图、fan-out→聚合编排。**编排终态，留最后。**

### E. 可写 subagent + git worktree（L-020）— L，依赖 ✅L-040，触安全边界
- **CC**：Agent `isolation:'worktree'` → `createAgentWorktree(slug)` 建临时 git worktree，子代理在隔离 checkout 可 Edit/Write，退出按改动决定清理。另有 EnterWorktree/ExitWorktree 给主会话。
- **deepcode 现状**：子代理强制只读（全局 deny [Edit,Write,Agent]）。`AgentDefinition` 已留 `tools`/`disallowedTools`。
- **怎么加**：① `AgentDefinition` 加 `isolation?:'worktree'`。② 新增可写类型 `implementer`（不在全局 deny 的 Edit/Write）。③ **关键**：从 `GLOBAL_SUBAGENT_DENY` 移除 Edit/Write（用类型级 deny 保 Explore/Plan 只读）。④ worktree：`git worktree add` 临时目录 + 子代理 cwd 指向它 + 退出校验/清理。⑤ 安全：可写子代理的权限委托（无 UI，需策略，参考 L-041 的 Bash yolo+钳制思路）。
- **价值**：并行改码、互不污染。压轴大件，brainstorm 时重点谈安全边界。

### F. MCP 客户端（L-022）— L
- **CC**：stdio/SSE 传输 + 服务器生命周期 + 工具/资源发现，MCP server 的 tool 进工具池。
- **deepcode 现状**：无。
- **怎么加**：① `src/mcp.ts`：MCP client（用 `@modelcontextprotocol/sdk`，stdio 先做、SSE 后）。② settings.json 配 mcpServers。③ 启动时连服务器、`listTools` → 包装成 deepcode `Tool` 注入工具池。④ 生命周期：连接/重连/关闭。
- **价值**：接生态（GitHub/DB/各种 MCP server）。中-大，等需求或用户想接特定 server 时做。

### G. Skills（自定义命令的全量版）— M
- **CC**：可复用 prompt 集（markdown + frontmatter），inline/fork 执行，有 description 供模型决定何时用，可带 allowed-tools。
- **deepcode 现状**：**自定义命令已覆盖 ~80%**（`~/.deepcode/commands/*.md` + `$ARGUMENTS`，见 `src/commands.ts`）。差的是：frontmatter 元数据、模型自主触发（而非用户敲 `/cmd`）、fork 执行。
- **怎么加**：① 扩 `commands.ts` 支持 frontmatter（description/allowed-tools）。② 让模型能"调用 skill"（注册成工具或 system prompt 列出可用 skills）。③ 可选 fork 执行（隔离上下文）。
- **价值**：低-中（命令已覆盖大半）。等需求。

### H. 用户自定义 agent（L-040 的 B 阶段）— M
- **CC**：`.claude/agents/*.md`（frontmatter: name/description/tools/model + 正文=system prompt），项目/用户/插件三层合并。
- **deepcode 现状**：L-040 只做了内建注册表（A 阶段），故意留 B。
- **怎么加**：扩 `src/tools/agentTypes.ts` 的 `BUILTIN_AGENTS` 加载逻辑：扫 `~/.deepcode/agents/*.md` + `<项目>/.deepcode/agents/*.md`，parse frontmatter（复用 `commands.ts` 的 md 加载思路），合并进注册表（用户覆盖内建）。**仿 CC `loadAgentsDir`。**
- **价值**：让用户定制专才 agent。小-中，L-040 自然延伸。

### I. Plan mode（L-007）— M，相对独立
- **CC**：`EnterPlanModeTool` 切只读权限模式 → 探查出计划 → `ExitPlanMode` 同步审批弹窗，批准后才执行。
- **deepcode 现状**：有权限模式 default/acceptEdits/yolo + AskUserQuestion 两块拼图，无 plan 门。
- **怎么加**：① `permissions.ts` 加 `'plan'` 模式（只读）。② EnterPlanMode/ExitPlanMode 工具。③ ExitPlanMode 走 AskUserQuestion 式审批 UI（TUI 弹窗，复用 PermissionDialog/QuestionDialog 模式）。
- **价值**：复杂多步前先对齐方案。中件、独立、可随时插。

---

## 建议顺序（新会话照此挑）

1. **A. Hooks（L-042）** — 无依赖、解锁 B、纯逻辑（非 TUI，免冒烟）。**最该先做。**
2. **B. 结构化输出（L-044）** — 紧接 A，让子代理结果可机器解析。
3. **H. 自定义 agent（L-040 B）** 或 **I. Plan mode（L-007）** — 独立中件，看用户兴趣。
4. **C. steering（L-043）** — 建在 L-041 上。
5. **E. 可写 subagent+worktree（L-020）** — 压轴，重谈安全。
6. **F. MCP（L-022）/ G. Skills** — 等需求。
7. **D. 多 agent 工作流（L-045）** — 地基全齐后的终态，最后做。

> **遗留 follow-up（小，随时补）**：L-041 进程树 kill（`spawn detached:true` + `process.kill(-pid)`，修 dev server 孤儿）。

## 自动 loop 与本路线图的关系

`loop/` 自对齐 loop 会自驱做**小/机械件**（小命令、bench、发现轮），**大件（上面这些 L 件）标 needs-human、只出 spec 草案等用户 brainstorm**。所以：用户在新会话挑上面任一机制深做（brainstorm→实现），loop 在后台清小件，两者不冲突。
