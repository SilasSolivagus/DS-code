# deepcode 自对齐 loop 设计

**日期：** 2026-06-15
**状态：** 已批（brainstorm Q1-Q5 + 设计全过）

---

## 目标

让 deepcode 持续向 Claude Code（CC）对齐、自我成长。一个 `/loop` 驱动的自治循环，不停地**拿实际场景测试、对照 CC 源码学习、找差距、补差距**。

**全自治**地跑完 `发现差距 → 设计 → 实现 → 双审 → opus 终审 → 测试` 整条链，只停在三道它**物理上跨不过**的闸门前。

## 三道闸门（不是偏好，是硬约束）

1. **Review 闸**：没有用户点头，什么都不进 `main`。每个差距落在自己的 `auto/<slug>` 分支，登记进 review 队列，用户独立合/弃/改。
2. **TUI 闸**：loop 是无 TTY 进程，**看不见也渲染不了终端 UI**。deepcode 史上最关键的 bug（欢迎页消失、中文 IME 飘框外、滚轮污染输入框）全是真机冒烟抓的、自动化测试全绿也测不出。所以**碰 TUI 的分支带冒烟清单，在用户真机验过前永远 `await-review:smoke`，不算完成**。
3. **发布闸**：npm 发布要用户 2FA OTP。loop **不碰用户凭证、不关 2FA**，发 npm 永远是用户手动。

## 组件（仓库内进程脚手架，非重代码）

| 文件 | 职责 |
|---|---|
| `loop/BACKLOG.md` | 活台账。每条：`id / 标题 / 来源(cc-src\|bench\|roadmap) / 规模(S/M/L) / 优先级 / 状态 / 分支 / 备注`。初始从 `docs/specs/2026-06-14-cc-gap-analysis.md` + README roadmap 灌入 |
| `loop/QUEUE.md` | review 队列。列待用户处理的分支，每条一句话摘要 + 怎么验（碰 TUI 附冒烟清单） |
| `loop/PLAYBOOK.md` | 每次 `/loop` 唤醒照着跑的剧本（递归 prompt 的落盘版） |

状态机（BACKLOG 条目）：`todo → doing → await-review[:smoke] → merged`，旁支 `needs-human`（连挂 2 次）、`blocked`（测试/bench 回归）。

## 两种迭代（交替）

### 实现轮（backlog 有就绪 S/M 项时，默认）

1. 挑 BACKLOG 顶部最高优先级、就绪、规模 S/M 的 gap。
2. **若是 L / 触安全边界 / 架构件 → 降级为只出 spec + plan 草案**，登记进队列等用户 brainstorm 拍板（接 deepcode "大件待 brainstorm" 的节奏）。
3. 否则开 `auto/<slug>` 分支 → spec/plan（按需）→ `subagent-driven-development` 每任务 implementer + 规格审 + 质量审双门 → opus 全量终审。
4. **跑全量测试 + bench 回归，必须全绿才入队。**
5. 碰 TUI → 标 `await-review:smoke` + 写冒烟清单；否则 `await-review`。
6. 更新 BACKLOG + 写 QUEUE 条目。

### 发现轮（就绪 backlog < 阈值 3 时）

精读一块还没对照过的 CC 子系统（`~/Desktop/src`）+/或 跑 bench 套件找 deepcode 表现差的场景 → 把新差距追加进 BACKLOG（带规模/优先级/来源）。CC 子系统挑选：初始按 roadmap/现有 gap 分析优先级，之后按"差距价值 × 可独立交付"自排。

## 四道刹车（默认值，用户可调）

1. **review 队列上限 = 5**：`await-review*` 分支攒到 5 条 → loop 停手长睡，等用户清掉再继续。
2. **失败即让路**：一个 gap 双审/终审连挂 2 次 → 退回 BACKLOG 标 `needs-human`，做下一个，不卡死。
3. **bite-sized scope 上限**：单轮 scope 超界 → 降级只出 spec。
4. **测试/bench 回归不绿** → 不入队、弃分支、标 `blocked` 记原因。

**不设 token 预算**（用户定）：靠 review 队列满 5 自然刹车 + 用户随时叫停。

## 节奏

**自定节奏**：`/loop` 不给间隔，靠 `ScheduleWakeup` 递归。每轮工作量差异巨大（改个小工具 vs 出一份 spec），固定间隔无意义。每轮末 `ScheduleWakeup` 下一轮；停手时长睡 + 定期回看。

## 数据流（一个实现轮）

```
BACKLOG 顶部 → 开 auto/<slug> 分支 → spec/plan → 实现 + 双审 → opus 终审
  → 全量测试 + bench 回归 → 全绿 → QUEUE(await-review[:smoke]) + BACKLOG 更新
  → ScheduleWakeup 下一轮
```

## 错误处理

| 情况 | 处理 |
|---|---|
| 双审/终审连挂 2 次 | BACKLOG 标 `needs-human`，做下一个 |
| 测试/bench 回归 | 弃分支，标 `blocked` 记原因 |
| rebase 冲突 | 备注，requeue 下轮再处理 |
| 大件/触安全边界 | 降级只出 spec+plan，入队等用户 |

## 边界与非目标

- loop 脚手架本身（`loop/*` + 本 spec）直接提交 `main`（基础设施，类比 `bench/`）。**只有 per-gap 特性工作走 `auto/` 分支闸门。**
- 不碰 npm 凭证、不关 2FA、不自动发布。
- 不自动合 main。
- 不自动实现大型架构件（worktree 等），只替用户做前期功课。

## 测试策略

loop 自身正确性主要是流程，安全网是硬规则：**任何分支入队前，全量测试 + bench 回归必须全绿**。这道规则保证 loop 产出的东西不破坏既有功能；TUI 类的视觉/交互正确性由 TUI 闸（用户真机冒烟）兜底。
