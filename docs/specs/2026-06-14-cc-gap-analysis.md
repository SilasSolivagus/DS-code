# CC 能力差距分析（刷新版）——deepcode v0.6.1 还差什么

2026-06-14。基准：deepcode **v0.6.1**（已发布 npm `@silassolivagus/deepcode`）对比 Claude Code 全量能力（源码实读 `/Users/silas/Desktop/src`）。更新 2026-06-12 旧版（彼时 v0.3.0-m3）。

视角：单人本地 + OpenAI 兼容（DeepSeek）+ 终局目标「达到 CC 差不多效果」。排序原则：价值/成本比。

## 一、deepcode 已追平的（旧 gap 文档里的项）

旧版 **Tier 1 四项全做完** + **Tier 2 的 WebFetch 也做了**：

| 旧项 | 状态 | 落在 |
|---|---|---|
| headless `-p --json` | ✅ | M4 |
| Edit/Write 权限弹窗 diff 预览 | ✅ | M5 |
| 模型/baseURL 可配（settings.json） | ✅ | M5 |
| `!` 直跑 + `@文件` 引用 | ✅ | M5 |
| WebFetch（CC 式：抓取+子模型作答） | ✅ | M6 |

deepcode v0.6.1 现状：9 工具（Read/Glob/Grep/Bash/Edit/Write/TodoWrite/Agent只读/WebFetch）+ 完整斜杠命令 + 会话持久化 + compact + CC 1:1 ink UI + 权限系统（default/acceptEdits/yolo）+ 代理 + npm 可发布。

## 二、CC 还有、对本地 DeepSeek CLI 真有价值的（已滤掉云端/内部专属）

源码实读（Explore agent 核实）后，按价值/成本排：

| 能力 | 价值 | 成本 | CC 实现机制（实读） | 判定 |
|---|---|---|---|---|
| **AskUserQuestion 工具** | 高（治「模型自作主张」） | **小** | 纯 zod schema（1-4 题/题 2-4 选项/可多选）+ TUI 菜单；headless 优雅降级 | 做 |
| **/rewind** | 高（长任务后悔药） | **小-中** | **before-image：Edit/Write 前把文件原内容备份到 checkpoints、按 message-id 索引**，rewind 还原+截断对话；上限 100 快照/会话。**非影子 git**——Bash 改动不管（CC 同样局限） | 做 |
| **可写 subagent + worktree** | 高（并行干活） | 大 | EnterWorktree 建 git worktree+切 CWD；AgentTool 可写（权限委托给底层工具）；ExitWorktree 校验/清理。CC 的 `isolation:"remote"` 是云端、砍掉 | 做（大件） |
| 后台 bash（run_in_background） | 中（dev server/watch） | 中 | BashTool 加 run_in_background → LocalShellTask 管生命周期+缓冲+通知；Shift+↑↓ 导航 | 候选 |
| Plan mode | 中 | 中 | EnterPlanMode 切只读权限模式 → 探查 → ExitPlanMode 写计划待批。核心通用，CC 的团队路由是云端 | 候选 |
| WebSearch | 中 | 小壳，但**需第三方搜索 API** | CC 直接用 Anthropic 内置 `web_search_20250305` beta——**不可复刻**；本地要接 Tavily/Serp 等并另配 key | 等需求 |
| MCP 客户端 | 中 | 大 | stdio/SSE 传输 + 服务器生命周期 | 等需求 |
| skills | 低-中 | 中 | 可复用 prompt 集，inline/fork 执行。**deepcode 自定义命令（md+$ARGUMENTS）已覆盖 ~80%** | 等需求 |
| hooks（Pre/PostToolUse 跑 shell） | 低 | 中 | 权限规则已覆盖大半 | 等需求 |

小 UX 命令 CC 有而 deepcode 无（都很小，随手）：`/diff`（暂存 diff）、`/export`、`/copy`、`/vim`、`/keybindings`、`/memory`（编辑记忆文件）、`/agents`、`/stats`/`/usage`。

## 三、两个关键修正（旧判断纠错）

1. **/rewind 比 2026-06-12 估的小**。M6 brainstorm 时我判断「忠实 rewind 需影子 git 整树、和 worktree 同源基建」——**实读 CC 源码发现 CC 自己也只做 Edit/Write 前的 before-image 文件备份（checkpoints + message-id 索引），不做影子 git**。Bash 改动 CC 也不还原（已知局限，可接受）。**结论：/rewind 是独立的小-中件，不必绑 worktree。**

2. **AskUserQuestion 浮现为最高性价比项**——不在旧 gap 文档、也不在 M7 原定范围，但 schema+菜单很小、直击「模型自作主张」长期痛点（用户 M5 试玩即吐槽）。

## 四、明确不抄（云端/内部/负价值）

- Anthropic 云端/内部：bridge/btw/good-claude/ant-trace/mobile/desktop/slack-app/github-app/oauth/heapdump/feedback/insights/advisor/teleport/teams·swarm（多人协作）/remote 隔离/WebSearch（内置 beta）
- 旧版 Tier 4 维持：多供应商(Bedrock/Vertex)、登录计费、企业策略、telemetry、自动更新、IDE 集成、沙箱、Windows、PowerShell、Notebook、LSP

## 五、M7 框定

原计划 M7 = `/rewind + 可写 subagent+worktree`。修正后更优的切法（worktree 是大件，/rewind 与 AskUserQuestion 是小件高价值）：

- **建议 M7 = AskUserQuestion + /rewind + 可写 subagent+worktree**（用户定「都做」）。三者**互相独立**（独立子系统），按「小→大」顺序、各自 spec→plan→实现：
  1. AskUserQuestion（小，先出，立即治痛点）
  2. /rewind（小-中，before-image 快照）
  3. 可写 subagent + worktree（大，压轴）
- 后台 bash / plan mode 视 M7 体量决定是否纳入或留 M8。
