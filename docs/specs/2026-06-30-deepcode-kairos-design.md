# 7.2 Kairos 自主循环 — 设计 spec

**日期**：2026-06-30
**对齐基准**：CC v2.1.193（`@anthropic-ai/claude-code-darwin-arm64@2.1.193`，bundle 实证）
**roadmap 位置**：阶段 B · T1 灵魂大件 7.2（`docs/specs/2026-06-26-deepcode-cc-v2193-gap-and-plan.md`）
**前置**：1.5 可写 subagent + worktree（已完成）、`src/tasks.ts` 后台任务底座（已有）

## 0. 一句话

把「模型自定步、按 cron 调度、对外部事件流响应」的自主长跑能力 1:1 复刻进 deepcode：五个工具（ScheduleWakeup / Monitor / CronCreate / CronList / CronDelete）+ TaskStop + PushNotification + `/loop` 命令 + 双哨兵自主循环 + `doneMeansMerged`，全部建在会话内的现有 task-notification 轨道上，**不引入 7.3 daemon 全套**。

## 1. 范围

**做（用户拍板：全量 1:1 CC、全自主）**：
- `ScheduleWakeup` —— 模型自定步唤醒（`/loop` 动态模式）
- `Monitor` —— 后台脚本 stdout 逐行 → `<task-notification>` 事件流
- `CronCreate` / `CronList` / `CronDelete` —— 5-field cron 调度，可 `durable` 跨重启
- `TaskStop` —— 按 id 停后台任务（Monitor persistent 必需；deepcode 当前缺）
- `PushNotification` —— 终端 OSC 桌面通知
- `/loop [interval] <prompt>` —— 内置命令展开 loop 编排指令
- 双哨兵自主循环 `<<autonomous-loop>>` / `<<autonomous-loop-dynamic>>`（+ `<<loop.md>>` 文件版）
- `doneMeansMerged` settings 键

**不做（明确边界）**：
- 7.3 daemon 全套（`/daemon` 脱钉进程、worker 池、adopt/respawn、PTY host）—— 专家裁决：上述工具均不依赖 daemon，会话内可完整实现；唯一让渡能力 = durable cron 在「无 REPL 打开」时也触发（这需要 daemon，押后 7.3）
- Monitor `ws` websocket 源 —— CC v2.1.193 **没有**此功能（bundle 实证，只接受 shell `command`），不自建
- PushNotification 手机推送 —— deepcode 无 Remote Control 桥，N/A

## 2. 架构

### 2.1 模块布局
```
src/services/scheduler/
├── index.ts      SchedulerService（会话绑定，单中央 tick）
├── store.ts      durable 持久化 + 按目录 lock + 漏跑 one-shot 补偿
├── cron.ts       纯逻辑：5-field cron 匹配 + nextFire 计算 + jitter（注入 now()）
├── sentinel.ts   双哨兵 resolver（首发全文 preamble / 后续短 tick reminder）
└── types.ts      WakeupEntry / CronJob / ScheduledEntry 类型
```

### 2.2 SchedulerService（单一事实源）
- 持有所有调度条目：`wakeup`（一次性、会话内、ScheduleWakeup 用）+ `cron`（5-field、可 durable、CronCreate 用）
- **单个中央 `setInterval` tick**（与 CC 同构：一个 timer 扫全部条目，逐条算 nextFire，到期且 idle 则触发）—— 非 per-entry timer
- 生命周期：`start()` / `stop()` / `reload()`（启动从 durable 文件重加并武装）/ `list()` / `cancel(id)`
- **idle 门**：tick 读注入的 `isIdle()`（= `!busy`，复用 useChat 现有 `busy` 标志）；busy 则推迟到下个 tick。CC 同样「只在 REPL idle 时触发」

### 2.3 与 useChat 接线（复用现有轨道，不发明新机制）
注入三回调：
- `isIdle: () => !busy`
- `fire: (prompt) => runTurn(...)` —— 复用现有 `wakeOnNotification → runTurn` 路径，`loop.ts:243-248` 的 drain-重入照常生效
- sentinel resolver（见 §5）

`start()` 在 useChat init 注册（紧挨现有 `onNotification` 订阅，约 `useChat.ts:957`），`stop()` 在 unmount/session end（`installTaskCleanup` 风格清 timer + 释 lock）。

### 2.4 Monitor 走 tasks.ts 旧轨道（不进 scheduler）
专家实证：CC 里 Monitor = `type:'local_bash'` + `kind:'monitor'` 判别符，骑 `Bash(run_in_background)` 同一 `taskRegistry`。deepcode 照搬：
- `BackgroundTask` 加 `kind?: 'monitor'`（`src/tasks.ts:11-31`）
- Monitor 工具 spawn 后台进程，**逐行 stdout** → `enqueueNotification`（per-line 事件，区别于 bash 的单次 exit 通知）
- `kind:'monitor'` 仅两点特化：①跳过单次完成通知器 ②跳过 capMs 时间上限（monitor 长寿命流多事件）
- `TaskType` 不新增；`toNotification`（`tasks.ts:87`）按 `kind` 给 monitor 加标签

## 3. 工具（schema + 常量全部 bundle 实证）

| 工具 | schema | 行为 | 实证常量 |
|---|---|---|---|
| **ScheduleWakeup** | `delaySeconds:number`(钳[60,3600]) `reason:string` `prompt:string` | 非阻塞。turn 末调用→钳值→**取整到下一整分钟**→派生 `min hour * * *` cron→注册 in-session `kind:"loop"`→turn 结束。idle 触发注入合成 user turn 携带 `prompt`。省略调用 = 循环结束 | clamp 60 / 3600 |
| **Monitor** | `command:string` `description:string` `timeout_ms:number`(默认 300000/max 3600000) `persistent:boolean`(默认 false) | 逐行 stdout = 1 事件；200ms 批合并；**令牌桶限流**；exit 结束 watch（报退出码）；timeout→kill；persistent→无 timeout 靠 TaskStop/会话结束停 | batch 200ms；令牌桶容量 10 / +1 每 2000ms / 持续超 30000ms 自动停；per-line 截 500 / 批截 3000 |
| **CronCreate** | `cron:string`(5-field 本地 tz) `prompt:string` `recurring:boolean`(默认 true) `durable:boolean`(默认 false) | 注册 cron；durable→持久化项目级文件。jitter + 7 天 age-out（最终一跑再删）+ 漏跑 one-shot 补偿（重启时）。只在 idle 触发 | jitter：recurringFrac **0.5** / cap **30min**（用 config 值，非文案 10%/15min，见 §7）；age-out 7 天 |
| **CronList** | — | 列出 session + durable 所有 job（id/cron/recurring/durable/nextFire） | — |
| **CronDelete** | `id:string` | 按 id 删（durable 同步改文件） | — |
| **TaskStop** | `task_id:string` | 停一个运行中的后台任务（含 Monitor）。deepcode 当前无此工具，本 spec 新增 | — |
| **PushNotification** | `message:string`(<200) `status:'proactive'` | 终端 OSC 转义桌面通知 | OSC 9 / 777 / 99 / bell（见 §7） |

工具计数：当前 12 → **19（+7：ScheduleWakeup / Monitor / CronCreate / CronList / CronDelete / TaskStop / PushNotification）**。计数断言 `test/tools.registry.test.ts:7` 与 `agent.test` 须同步更新。

`GLOBAL_SUBAGENT_DENY`（`src/tools/agentTypes.ts:19`）追加调度/通知/停止类工具（比照 Workflow，子代理不应操控会话级循环）：ScheduleWakeup、CronCreate、CronList、CronDelete、PushNotification、Monitor、TaskStop。

## 4. `/loop` 命令

`/loop` 在 CC 是 skill；deepcode 无内置 skill 打包机制（skills 只从 user/project 目录加载），故落地为**内置命令展开**（比照 `INIT_PROMPT`，`src/commands.ts` / `useChat.ts` if-cascade）：
- **`/loop <interval> <prompt>`**（有区间）→ 展开指令让模型把区间转 5-field cron 并 `CronCreate(recurring:true)` + 立即跑首 tick
- **`/loop <prompt>`**（无区间）→ 自起步：现在跑任务，turn 末 `ScheduleWakeup` 续命（兜底 delaySeconds 1200–1800s，若有 Monitor 当主唤醒信号）
- **`/loop`**（无 prompt）→ 自主循环：有 `<cwd>/.deepcode/loop.md`（截 25000 字节，回退 `~/.deepcode/loop.md`）走文件版哨兵，否则走默认 preamble 哨兵；展开后立即跑，不等首次 cron

## 5. 双哨兵 + keepalive

### 5.1 哨兵解析（`sentinel.ts`，fire 时）
- 两哨兵：`<<autonomous-loop>>`（CronCreate 模式）/ `<<autonomous-loop-dynamic>>`（ScheduleWakeup 模式）——**永不互换**。外加文件版 `<<loop.md>>` / `<<loop.md-dynamic>>`
- resolver：传入 prompt 若是哨兵 → 解析；否则原样透传
- **首发 prepend 完整 preamble**（`vBt` 风格首发标志），**后续只发短 tick reminder**（长指令留在缓存前缀，省 token）。会话内维护 first-fire 标志，会话/循环重置时清

### 5.2 verbatim 文本（照搬本地化，见附录 A）
- 完整 preamble（首发）：自主检查清单 —— 重读 transcript → 在途 PR（review 线程/失败 CI/冲突）→ 未完成实现 →「我还会…」承诺 → PR 维护 → 安静时找 bug/简化；不可逆动作的可逆性规则；「连续 ≥3 次没找到可做的，先扩一次范围再考虑停」
- 短 tick（cron 版 / dynamic 版）：见附录 A

### 5.3 keepalive 安全网（load-bearing，易漏）
动态循环里模型 turn 末**没**重新调度 → runtime 自动武装 **1 个 1200s 兜底唤醒**；keepalive budget = 1；模型**连续两次**不续 = 循环结束。不做这个 → 循环会无声卡死。

## 6. doneMeansMerged

deepcode `Settings`（`src/config.ts`）加布尔键 `doneMeansMerged`。为 true 时**门控 autonomous-loop preamble 第二段的变体选择**（附录 A 实证两变体并存）：
- **false（默认）= 变体 A**：「连续 ≥3 次没找到可做的 → 安静，做一次 CI/threads 检查后单行停」
- **true = 变体 B**：「连续 ≥3 次没找到可做的 → 先扩一次范围（重读原任务/查 sibling work/找漏掉的验证或 polish）再考虑停；一个一安静就退的循环不如会等的循环」—— 即干到 PR merge-ready / 武装了 cron-or-Monitor / 交付自包含下一步 三者之一才停
- 专家初判「无 in-process 消费点」得到精化：它**不是属性读取式的门控，而是 preamble 变体选择器**（故 grep 属性访问查不到）。deepcode 落地 = `sentinel.ts` 解析 preamble 时按 `doneMeansMerged` 选变体
- 写入/网络动作（commit/push/PR）仍走现有 permissions 门控（default 问 / acceptEdits 自动 / yolo 全放）

## 7. Fidelity 决策（1:1 vs 适配）

| 项 | CC v2.1.193 | deepcode | 理由 |
|---|---|---|---|
| daemon 边界 | 调度工具会话内 + 可选 daemon 层 | 仅会话内，不做 daemon | 专家裁决工具不依赖 daemon；daemon=7.3 |
| Monitor ws 源 | **无** | 无 | bundle 实证 CC 没有 |
| PushNotification 通道 | OSC 桌面 + Remote Control 手机 | **OSC 桌面 + 独立 BEL 响铃兜底**，手机 N/A | deepcode 无 Remote Control 桥；OSC 桌面弹窗依赖终端启用通知（ghostty 需 `desktop-notifications`+macOS 授权），故补独立 BEL 让未启用终端至少响一声（偏离 CC 纯 OSC，务实增强）|
| ScheduleWakeup 缓存窗口 | sub-300s cache-lead pull-in + 「别选 300s 留缓存」文案 | **删 pull-in 与该文案**，保 [60,3600] 钳 + 取整 + keepalive | Anthropic 300s prompt-cache TTL 专属；deepcode 跑 DeepSeek/GLM 缓存机制不同 |
| `/loop` 形态 | skill 文件 | 内置命令展开 | deepcode 无内置 skill 打包，比照 INIT_PROMPT |
| Monitor 任务模型 | `local_bash`+`kind:monitor` | 同 | 1:1 |
| jitter 数值 | config 0.5/30min（运行时） vs 文案 10%/15min（建议）| 用 **config 值** | config 治理运行时，文案仅建议；两者 CC 自身不一致 |
| durable 路径 + 信任边界 | 项目级 `<cwd>/.claude/scheduled_tasks.json`，启动自动重加，无信任门 | **1:1：项目级 `<cwd>/.deepcode/scheduled_tasks.json`，无信任门**（用户拍板） | 见 §9 安全 |
| Monitor plan-mode 执行 | Monitor `isReadOnly` 标记（CC 同标只读/并发安全）| **1:1：保持 `isReadOnly:true`，不在 plan-mode 门额外拦**（用户拍板 2026-06-30）| Monitor 实际 `bash -c <command>` 执行任意 shell；deepcode plan-mode 门（`permissions.ts:232`）只拦 `!isReadOnly`→Monitor 在 plan mode 可执行 shell，破「只读探索」契约。**已知接受风险**（CC 也标只读，可能同此行为）；缓解=子代理 deny-list + isSubagent guard 仍生效，仅 plan-mode 主会话可触 |

## 8. durable 持久化（`store.ts`）

- 路径：`<cwd>/.deepcode/scheduled_tasks.json`（项目级，1:1 CC 布局）
- 按目录 lock：`<cwd>/.deepcode/scheduled_tasks.lock`，每目录单 owner 触发，防两会话共享 cwd 时双触发
- 启动 `reload()`：读 JSON → 武装 durable 条目；**漏跑 one-shot 补偿**（REPL 关闭期间错过的 one-shot 在重启时浮出 catch-up）
- 7 天 age-out：recurring 超 7 天最终一跑再删
- 损坏容错：JSON 解析失败 → 记日志忽略，不崩启动（比照其他 config 加载）

## 9. 安全 / 信任边界

- **已知接受风险（用户拍板纯 1:1）**：`<cwd>/.deepcode/scheduled_tasks.json` 项目级、启动自动重加武装。恶意 repo 可塞此文件，开项目即自动跑其 prompt → 工具调用。缓解 = 写入/危险动作仍走 permissions 门控（default 会问；**yolo/acceptEdits 下风险实质化**）
- **后续可选加固（follow-up，非本 spec）**：首次加载本会话未创建过的 repo 提供文件时加一次性信任确认门（CC 布局 + deepcode 加固，两全）
- 调度/通知工具进 `GLOBAL_SUBAGENT_DENY`（子代理不能操控会话级循环或推通知）

## 10. 数据流

1. **ScheduleWakeup**：注册 wakeup → turn 结束 → tick 到期且 idle → 解析哨兵 → `fire=runTurn` → `loop.ts:243` 现有 drain 重入 → 模型动作 → 续调度 或 keepalive 兜底
2. **CronCreate**：注册 cron（durable→`store` 持久化）→ tick recurring/one-shot 到期且 idle 触发
3. **Monitor**：后台进程 `kind:monitor` → 逐行 `enqueueNotification` → 现有 `wakeOnNotification → runTurn`
4. **PushNotification**：OSC 转义写 stdout，副作用，不起 turn
- idle 门贯穿 1/2；3/4 经现有通知轨道（`priority:"next"` 语义，下个 turn 边界投递，与 steering 软中断天然不冲突）

## 11. 错误处理

- 非法 cron（非 5-field / 越界）→ 工具调用即拒，返回明确错误
- durable 文件损坏 → 记日志忽略，不崩启动
- Monitor 失控（超令牌桶）→ 抑制并计数；持续超 30s → 自动停 + 通知「换更紧的过滤」
- 7 天 age-out 最终一跑
- lock 争用 → 每目录单 owner，第二会话不双触发
- 会话结束 → 清 timer、停 Monitor 子进程、释 lock（`installTaskCleanup` 风格）

## 12. 测试

- `cron.ts` 纯逻辑：5-field 匹配 / nextFire / jitter（注入 `now`）/ clamp / 取整到分钟
- `sentinel.ts`：首发全文 preamble vs 后续短 tick、双哨兵不互换、loop.md 文件版
- `store.ts`：durable 往返 / 漏跑 one-shot 补偿 / lock / 7 天 age-out 最终一跑 / 损坏文件容错
- `SchedulerService` tick：到期判定 / idle 门 / **keepalive（1200s 武装、budget 1、连续两次不续即停）**
- 工具：schema 校验、注册、计数断言（12→19）、`GLOBAL_SUBAGENT_DENY` 子代理禁用断言
- Monitor：行→通知、`kind:monitor` 跳过完成通知器与 capMs、令牌桶上限
- `/loop` 解析：有/无区间/无 prompt 三分支
- **真机冒烟（glm-5.2 端到端）**：①`/loop` 自起步（ScheduleWakeup 续命 + keepalive 兜底）②durable cron 跨重启恢复 + 漏跑补偿 ③Monitor 流式事件 + TaskStop ④PushNotification OSC 桌面通知

## 13. 集成 seam（recon 实证 file:line）

| 用途 | 文件 | 锚点 |
|---|---|---|
| 后台任务注册 + 通知队列 | `src/tasks.ts` | 11-31（BackgroundTask 加 `kind`）/ 87（toNotification）/ 108（enqueueNotification）|
| 主循环通知 drain-重入 | `src/loop.ts` | 35（LoopDeps.injectTaskNotifications）/ 243-248（drain + 重入）|
| 命令分发 + 通知唤醒订阅 | `src/tui/useChat.ts` | 968-1349（if-cascade，加 `/loop`）/ 950-957（wakeOnNotification + onNotification）|
| 后台 spawn 范式 | `src/tools/bash.ts` | 47-82（run_in_background）|
| poll-abort 范式 | `src/tools/sleep.ts` | 19-29 |
| 工具注册 | `src/tools/index.ts` | 17（allTools 数组）|
| 子代理禁用名单 | `src/tools/agentTypes.ts` | 19（GLOBAL_SUBAGENT_DENY）|
| ToolContext 字段 | `src/tools/types.ts` | 20-50（signal/cwd/isSubagent/sessionId）|
| 配置目录 / settings | `src/config.ts` | 90-97（~/.deepcode、TASKS_DIR）|

## 14. 附录 A — verbatim CC 文本（实现时本地化照搬）

> 来源：bundle v2.1.193 grep -a 实证（两份 opus 专家报告）。`${...}` 为运行时插值。

**短 tick（CronCreate 版，`qzi`）**：
```
# Autonomous loop tick
Run the autonomous check using the loop instructions established earlier in this conversation. If you cannot find them, treat this as a no-op tick. The recurring cron will fire the next tick automatically — do not call ScheduleWakeup from this tick.
```

**短 tick（dynamic 版，`k5d`）**：
```
# Autonomous loop tick (dynamic pacing)
Run the autonomous check using the loop instructions established earlier in this conversation. If you cannot find them, treat this as a no-op tick.
You scheduled this tick via the ScheduleWakeup tool (not a recurring cron). To keep the loop alive, call ScheduleWakeup again at the end of this turn with `prompt` set to the literal sentinel `<<autonomous-loop-dynamic>>` — otherwise the loop ends after this tick.
```

**完整 preamble（首发，`Pzi`）—— verbatim 两变体（grep 实证，照搬本地化）**：

变体 1（首段公用）：
```
# Autonomous loop check
The current conversation is your highest-signal source — re-read the transcript above, since everything there is something the user was actively engaged with. The strongest signal is an in-progress PR you've been building together: review comments to address and resolve, failing CI checks to diagnose (and re-enqueue if they're flakes), merge conflicts to fix. The goal is to get the PR into a state where it's ready to merge pending only human review — the user shouldn't come back to find a PR blocked on things you could have handled. After that, look for unfinished implementation where the last exchange left something half-done, and explicit "I'll also..." or "next I'll..." commitments the conversation made and didn't honor. Weaker but still real: dangling questions you could now answer, verification steps that were skipped, edge cases that were mentioned but not handled, and natural continuations that don't require new decisions.
```

第二段 **两变体**（🔑 疑似对应 `doneMeansMerged`：变体 A「安静就停」= 默认；变体 B「先扩范围再停」= persistent/merge-ready）：
```
[变体 A · 默认 · 安静就停]
If you see earlier autonomous checks in this conversation, adjust your scope accordingly. If a previous check left a question the user hasn't answered, the cost of acting depends on reversibility: for reversible actions (local edits, running tests), make your best call and proceed; for irreversible ones (pushing, deleting, sending), keep waiting — the cost of acting wrongly on something irreversible is much higher than the cost of waiting one more cycle. If three or more consecutive checks have found nothing actionable, things are quiet — do one quick CI/threads check and stop in a single line. Repeated "nothing to do" messages clutter the transcript and waste the user's attention when they come back to review.

[变体 B · persistent / merge-ready · 先扩范围再停]
If you see earlier autonomous checks in this conversation, adjust your scope accordingly. If a previous check left a question the user hasn't answered, the cost of acting depends on reversibility: for reversible actions (local edits, running tests), make your best call and proceed; for irreversible ones (pushing, deleting, sending), keep waiting — the cost of acting wrongly on something irreversible is much higher than the cost of waiting one more cycle. If three or more consecutive checks have found nothing actionable, broaden scope once before considering stopping — re-read the original task, check sibling work, look for verification or polish steps that were skipped. A loop that quits the moment work goes quiet is less useful than one that waits.
```
> 实现时确认变体选择是否由 `doneMeansMerged` 门控（grep 实证两变体并存；§6 已据此落地）。reversibility 段与 deepcode 现有「谨慎执行破坏性动作」系统段（P1 prompt parity 已 verbatim 镜像 G5z）重叠，preamble 内可复用同源措辞不重复注入。

**ScheduleWakeup 结果文案**：
- 成功：`Next wakeup scheduled for ${o} (in ${s}s)... Nothing more to do this turn — the harness re-invokes you when the wakeup fires or a task-notification arrives.`
- 关闭/超时：`Wakeup not scheduled. Either the /loop dynamic runtime gate is off or the loop reached its maximum duration — the loop has ended; do not re-issue.`

**Monitor 限流文案**：
- 停止：`[Monitor stopped — your script produced too much output (${d} events suppressed over ...s). Write a new monitor command that filters more aggressively...]`
- 抑制：`[${d} events suppressed — output rate too high. Consider using TaskStop to restart this monitor with a more selective filter.]`

## 15. 附录 B — jitter config（`LW`，bundle 实证）
```
recurringFrac: 0.5            // recurring 抖动占周期比例
recurringCapMs: 1800000       // recurring 抖动上限 30min
oneShotMaxMs: 90000           // one-shot 落 :00/:30 提前上限 90s
oneShotMinuteMod: 30
recurringMaxAgeMs: 604800000  // 7 天 age-out
cacheLeadMs: 15000            // (CC 专属缓存提前量，deepcode 不用)
```

## 16. 开放 follow-up（非阻塞）
- durable 文件首次加载信任门（§9 加固，可选）
- daemon 层让 durable cron 在无 REPL 时也触发（=7.3，押后）
- PushNotification 终端类型探测（OSC 9/777/99 按 `$TERM`/`$TERM_PROGRAM` 选，无则 bell 降级）
- ScheduleWakeup 缓存提前量：未来 deepcode 侧若做 prompt 缓存优化可回补一个 provider-aware 版本
