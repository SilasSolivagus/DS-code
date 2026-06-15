# deepcode 自对齐 loop — 剧本（PLAYBOOK）

每次 `/loop` 唤醒照此执行**一轮**。设计见 `docs/specs/2026-06-15-deepcode-self-alignment-loop-design.md`。
目标：让 deepcode 持续向 CC（源码 `~/Desktop/src`）对齐。全自治，只停在三道闸门前（Review / TUI 冒烟 / npm OTP）。

---

## 每轮开场（必做）

1. `cd ~/loop/deepcode`，`git checkout main`，确认 working tree 干净（脏就先弄干净）。
2. 读 `loop/QUEUE.md`：数 `await-review*` 条目。
   - **≥ 5 条 → 刹车**：本轮什么都不做，`ScheduleWakeup` 长睡（1800s），reason 写"review 队列满 5，等用户清"。结束。
3. 读 `loop/BACKLOG.md`，数 `todo` 且规模 S/M 的"就绪"项。
   - **就绪 < 3 → 走「发现轮」**；否则走「实现轮」。

## 实现轮

1. 挑 BACKLOG 顶部最高优先级、`todo`、S/M 的 gap。标 `doing`。
2. **若实际是 L / 触安全边界 / 架构件 → 降级**：只产出 spec（`docs/specs/`）+ plan 草案，BACKLOG 标 `needs-human` 并备注 spec 路径，写 QUEUE 条目（类型=spec-only）。跳到「收尾」。
3. 否则开分支：`git checkout -b auto/<slug>`。
4. 按需 spec/plan（小到 trivial 可省）。**`superpowers:subagent-driven-development`**：每任务 implementer + 规格审 + 质量审双门。**改动较大时末加一轮 opus 全量终审**（S 件可省，M 件建议加）。审查发现的真问题必须修。
5. **闸门：跑全量 `npm test` + `npm run typecheck` + `npm run build` + bench 抽测（碰工具/loop 逻辑时）。**
   - 不全绿 → 弃分支（`git checkout main; git branch -D auto/<slug>`），BACKLOG 标 `blocked` 记原因。跳「收尾」。
   - 双审/终审连挂 2 次 → BACKLOG 标 `needs-human`，弃分支。跳「收尾」。
6. 全绿 → 在分支上提交（`finishing-a-development-branch` 风格，**不合 main**）。
7. 判定是否碰 TUI（改了 `src/tui/` 渲染/布局/输入处理 = 碰）：
   - 碰 → BACKLOG 标 `await-review:smoke`，QUEUE 条目附**具体冒烟步骤**。
   - 没碰 → BACKLOG 标 `await-review`。
8. 写 QUEUE 条目（按文件内模板）。跳「收尾」。

## 发现轮

1. 挑一块**还没对照过**的 CC 子系统（`~/Desktop/src`，初始按 roadmap/gap 分析优先级，之后按价值×可独立交付）**或**跑一轮 bench 找 deepcode 表现差的场景。
2. 用 `Explore`/`general-purpose` subagent 精读对照，产出新差距（带 规模/优先级/来源/一句话）。
3. 追加进 BACKLOG `todo` 表。**不碰代码。** 跳「收尾」。

## 收尾（必做）

1. 提交 `loop/BACKLOG.md`、`loop/QUEUE.md` 的更新到 **main**（loop 台账是基础设施，直接进 main；**只有 per-gap 特性代码走 auto/ 分支闸门**）。
2. 一句话进度播报给用户（本轮做了什么、QUEUE 现状 N/5）。
3. `ScheduleWakeup` 下一轮：正常 600s、刹车 1800s。`prompt` 传 `<<autonomous-loop-dynamic>>`（无人值守）或用户原始 /loop 输入。

---

## 铁律

- **三道闸门不可越**：不自动合 main、碰 TUI 必等真机冒烟、不碰 npm 凭证/不自动发布。
- **入队前必全绿**：测试/typecheck/build 不绿的东西绝不进 QUEUE。
- **bite-sized**：单轮只啃一个 gap；超界就降级只出 spec。
- **不卡死**：失败即让路（`needs-human`/`blocked`），做下一个。
- **如实记台账**：每轮如实更新 BACKLOG/QUEUE 状态，不谎报成功。
- **遵循 deepcode 既有惯例**：`~/.claude/CLAUDE.md` + 项目流程（subagent-driven 双审）。
