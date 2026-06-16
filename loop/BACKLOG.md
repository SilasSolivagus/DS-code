# deepcode 自对齐 loop — 差距台账（BACKLOG）

活台账：deepcode 对比 CC（源码 `~/Desktop/src`）的差距。loop 每个**实现轮**从顶部挑最高优先级、就绪、规模 S/M 的 gap 做；**发现轮**往这里追加新差距。设计见 `docs/specs/2026-06-15-deepcode-self-alignment-loop-design.md`。

**状态：** `todo`（待做）｜`doing`（进行中）｜`await-review`（待你合）｜`await-review:smoke`（待你真机冒烟）｜`needs-human`（需你介入/brainstorm）｜`blocked`（回归挂了，记原因）｜`merged`（已合 main）

**规模：** S（机械/小，loop 自动实现）｜M（中，loop 自动实现）｜L（大/架构/触安全边界，loop **只出 spec+plan** 等你 brainstorm）

基准：deepcode **v0.7.1**（AskUserQuestion ✅ /rewind ✅ M8 全屏可滚+滚轮 ✅ 已发布）。

---

## 待做（todo）

| id | 标题 | 来源 | 规模 | 优先级 | 状态 | 分支 | 备注 |
|---|---|---|---|---|---|---|---|
| L-006 | 后台 bash `run_in_background` | cc-src | M | P2 | todo | — | BashTool 加后台模式 + 任务生命周期/缓冲/通知；dev server/watch 用。**注：编排分析后并入 L-041 后台任务体系** |
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

## 编排层差距（2026-06-15 发现轮，实读 CC 源码对照）

**总评：** deepcode 编排内核停在"主 agent 同步派一个一次性、只读、无名、纯文本回传的搜子"。缺的那层本质是 **agent 的"对象化"**——CC 把每个被委派单元变成有类型/有 id/有生命周期/可寻址/可隔离/可后台/结果有契约的一等对象。先补 G1 类型化 + G6 后台任务句柄两块地基，其余编排能力才有挂载点。
**已纠正：** 回合内并行只读工具执行 deepcode **已有**（`loop.ts:142` CONCURRENCY=5 只读批 Promise.all），非缺口。
**依赖链：** G1 → {G2=L-020, G6}；G6 → {G3, G8}；G4 → G7 → G8。

| id | 标题 | 规模 | 价值 | 状态 | 依赖 | 备注 |
|---|---|---|---|---|---|---|
| ~~L-040~~ | **子代理类型化** ✅ **已合 main** | M | 高 | **merged** | — | 见下「已合并」。L-041/L-020/L-044/L-045 的挂载点已就位 |
| ~~L-041~~ | **后台任务 + 完成通知** ✅ **已合 main** | L | 高 | **merged** | — | 见下「已合并」。L-043/L-045 的挂载点已就位。**遗留 follow-up（opus nit）**：TaskStop/退出清理只 kill 直接进程不杀进程树，`npm run dev` 这类 fork 子进程会留孤儿——需 spawn `detached:true` + `process.kill(-pid)`，待跟进 |
| **L-042** | Hooks 生命周期（Pre/PostToolUse/SubagentStop/…） | M | 中 | needs-human | 无 | `execCall` 前后插可插拔 dispatch 点。本身偏策略层，但**是 L-044 结构化输出的底座** |
| **L-043** | 子代理 steering / 续聊（SendMessage 式注入 + 可恢复） | L | 中-高 | needs-human | L-041 | 当前子代理是一次性纯函数、不可寻址；主 loop 也 busy 拒输入（仅 Esc 全中断）。建在后台任务句柄上 |
| **L-044** | 结构化输出强约束（子代理结果按 schema 校验回传） | M | 中 | needs-human | L-042 | CC 用 Stop hook + SyntheticOutputTool 强制子代理产出符合 schema 的 JSON。让父代理拿机器可解析结果而非自由文本。服务于 fan-out 聚合 |
| **L-045** | 多 agent 工作流原语（team/fan-out/pipeline + 任务依赖图） | L | 中（长期高） | needs-human | G1+L-041+L-043 | 编排终态，强依赖前述地基，**最后做** |
| **L-046** | 子代理错误恢复 / 重试编排 | S-M | 中 | needs-human | L-041 | 当前靠模型层兜底基本够；属增量打磨，优先级低 |

> 交叉引用：**G2 = L-020**（可写 subagent+worktree，依赖 L-040 类型化）；**G5 = L-007**（plan mode，相对独立可并行）；**G6 ⊇ L-006**（后台 bash 是 L-041 的子集）。
> **接下来最该做的 3 件**（分析师荐）：① L-040 子代理类型化（M，无依赖，解锁最多）② L-041 后台任务句柄（L，地基）③ L-007/G5 Plan mode 单用户版（M，已有权限模式+AskUserQuestion 两块拼图，可并行）。

## 已发现但低优先（等需求）

- skills（自定义命令已覆盖 ~80%）、hooks（权限规则已覆盖大半）、`/vim` 输入模式、`/export` 之外的 `/agents`。发现轮按需补充。

---

## 已合并（merged）

- **2026-06-15 第一批 5 个小 UX 命令**（用户授权合并，313 测试全绿、typecheck/build 干净；真机冒烟用户日后顺手扫一眼）：
  - L-001 `/export` 导出对话到 markdown（merge `e5f49b0`）
  - L-002 `/copy` 复制上条回复到剪贴板（merge `9c10e6d`）
  - L-003 `/stats` 本会话统计（merge `5de2826`）
  - L-004 `/memory` 查看生效的记忆文件（merge `4f3d784`）
  - L-005 `/keybindings` 查看快捷键（merge `54257a9`）
- **2026-06-15 L-040 子代理类型化**（编排地基，交互 brainstorm + CC 源码对齐，三重门：实现+独立审+opus 终审）：`subagent_type` 路由 + `AgentDefinition` + 纯函数 `resolveAgentTools`（deny 赢 allow）+ 3 内建只读类型（general-purpose/Explore/Plan）+ Bash yolo 钳制 + 全局 deny [Edit,Write,Agent] 守可写边界。333 测试全绿。spec `docs/specs/2026-06-15-deepcode-subagent-typing-design.md`。**L-041/L-020/L-044/L-045 的挂载点就位**：全局 deny 移除 Edit/Write 即解锁可写子代理。
- **2026-06-16 L-041 后台任务 + 完成通知**（编排地基，CC 源码对齐，spec→writing-plans(7任务)→subagent-driven 每任务双审→opus 全量终审→真机冒烟）：`run_in_background`（Bash spawn 写盘 / Agent 脱钩，启动即返句柄）+ `<task-notification>` 完成通知（runLoop 终止点 `injectTaskNotifications` drain 注入 + useChat idle 唤醒）+ `TaskList/TaskOutput/TaskStop` + 退出清理。`src/tasks.ts` 任务表/通知队列/去重。389 测试全绿。spec `docs/specs/2026-06-15-deepcode-background-tasks-design.md`、计划 `docs/plans/2026-06-15-deepcode-l041-background-tasks.md`。**关键设计**：通知队列模块级单例，`injectTaskNotifications` 默认 false，子代理不 drain（防吞主会话通知）；子代理禁起后台任务（`ctx.isSubagent`）。冒烟抓修：TaskStop 后 exit 回调覆写 killed→failed（加守卫）。**遗留**：进程树 kill（dev server 孤儿）。**L-043/L-045 挂载点就位**。release `v0.8.0`。
