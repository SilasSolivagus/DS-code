# deepcode 自对齐 loop — 差距台账（BACKLOG）

活台账：deepcode 对比 CC（源码 `~/Desktop/src`）的差距。loop 每个**实现轮**从顶部挑最高优先级、就绪、规模 S/M 的 gap 做；**发现轮**往这里追加新差距。设计见 `docs/specs/2026-06-15-deepcode-self-alignment-loop-design.md`。

**状态：** `todo`（待做）｜`doing`（进行中）｜`await-review`（待你合）｜`await-review:smoke`（待你真机冒烟）｜`needs-human`（需你介入/brainstorm）｜`blocked`（回归挂了，记原因）｜`merged`（已合 main）

**规模：** S（机械/小，loop 自动实现）｜M（中，loop 自动实现）｜L（大/架构/触安全边界，loop **只出 spec+plan** 等你 brainstorm）

基准：deepcode **v0.7.1**（AskUserQuestion ✅ /rewind ✅ M8 全屏可滚+滚轮 ✅ 已发布）。

---

## 待做（todo）

| id | 标题 | 来源 | 规模 | 优先级 | 状态 | 分支 | 备注 |
|---|---|---|---|---|---|---|---|
| L-001 | `/export` 导出对话到 markdown 文件 | cc-src | S | P1 | await-review:smoke | auto/slash-export | 纯函数 `exportTranscript(messages,meta)→md` + /export[path] 接线；8 单测，285 全绿；双审过。碰 `src/tui/`（命令菜单+notice），待真机冒烟 |
| L-002 | `/copy` 复制上条回复到剪贴板 | cc-src | S | P1 | await-review:smoke | auto/slash-copy | 纯函数 `lastAssistantText` + `copyToClipboard`(pbcopy)；9 单测，286 全绿；双审 Approved。碰 `src/tui/`，待真机冒烟 |
| L-003 | `/stats` 会话统计（轮数/工具调用/tok/缓存命中） | cc-src | S | P2 | await-review:smoke | auto/slash-stats | 纯函数 `sessionStats`+`formatStats`；10 单测，287 全绿；双审 Approved-with-nits。碰 `src/tui/`，待真机冒烟 |
| L-004 | `/memory` 打开/编辑记忆文件（DEEPCODE.md） | cc-src | S | P2 | todo | — | 定位项目+全局 DEEPCODE.md，$EDITOR 打开 |
| L-005 | `/keybindings` 展示快捷键 | cc-src | S | P3 | todo | — | 静态展示现有键位 |
| L-006 | 后台 bash `run_in_background` | cc-src | M | P2 | todo | — | BashTool 加后台模式 + 任务生命周期/缓冲/通知；dev server/watch 用 |
| L-007 | Plan mode（EnterPlanMode/ExitPlanMode） | cc-src | M | P2 | todo | — | 切只读权限模式探查 → 出计划待批 |

## 大件 / 只出 spec（L，等你 brainstorm）

| id | 标题 | 来源 | 规模 | 优先级 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| L-020 | 可写 subagent + git worktree（M7③） | roadmap | L | P1 | needs-human | 压轴大件，触安全边界；loop 只产出 spec+plan 草案 |
| L-021 | M8 P3 应用内选中复制 | roadmap | L | P2 | needs-human | TUI 选区高亮+pbcopy；需 brainstorm，loop 只出 spec |
| L-022 | MCP 客户端 | cc-src | L | P3 | needs-human | stdio/SSE 传输+服务器生命周期；等需求 |

## 阻塞 / 需外部（blocked / needs-human）

| id | 标题 | 来源 | 规模 | 优先级 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| L-030 | WebSearch | cc-src | M | P3 | needs-human | 需第三方搜索 API（Tavily/Serp）+ 另配 key；不可纯复刻，等你定供应商 |

## 已发现但低优先（等需求）

- skills（自定义命令已覆盖 ~80%）、hooks（权限规则已覆盖大半）、`/vim` 输入模式、`/export` 之外的 `/agents`。发现轮按需补充。

---

## 已合并（merged）

（loop 合入 main 的 gap 移到这里，留痕）
