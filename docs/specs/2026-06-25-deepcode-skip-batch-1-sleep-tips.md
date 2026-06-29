# Spec — SKIP 件批1：4.3 Sleep 工具 + 5.10 Spinner tips 轮播

**日期**：2026-06-25
**背景**：用户拍板「原 SKIP 9 件全部像 CC 一样做」，分批推进。本批 = 易件快赢批（两件纯本地、无外部依赖）。
**实读来源**：CC bundle v2.1.76（`/opt/homebrew/lib/node_modules/@anthropic-ai/.claude-code-2DTsDk1V/cli.js`）+ deepcode 现状（2 agent 实挖）。
**流程**：本 spec → writing-plans → SDD（fresh subagent + sonnet 双审）→ opus 全分支终审 → 真机冒烟（碰 TUI）→ 合并。

---

## 件 A：4.3 Sleep 工具（可打断的等待）

### CC 真实行为（逐字实读）
- 工具名 `Sleep`，`isReadOnly()=true`，`isConcurrencySafe(input)=true`，`interruptBehavior()=cancel`（用户可中断）。
- 描述原文（变量 `MzO`）：
  > Wait for a specified duration. The user can interrupt the sleep at any time.
  > Use this when the user tells you to sleep or rest, when you have nothing to do, or when you're waiting for something.
  > You may receive `<tick>` prompts — these are periodic check-ins. Look for useful work to do before sleeping.
  > You can call this concurrently with other tools — it won't interfere with them.
  > Prefer this over `Bash(sleep ...)` — it doesn't hold a shell process.
  > Each wake-up costs an API call, but the prompt cache expires after 5 minutes of inactivity — balance accordingly.
- **input schema 未在 bundle 中找到**（参数名/单位未暴露）。
- `<tick>` check-in = **调度层在后台周期注入**的提示，Sleep 工具本身不产生；**deepcode 无此调度层**。

### deepcode 落地
- **新建 `src/tools/sleep.ts`**，参照 `src/tools/bash.ts` 结构（name/description/inputSchema/isReadOnly/needsPermission/call）。
- **inputSchema**：`{ seconds: number }`，正整数，**上限 3600**（防误填巨值卡死）。
  - 决策：CC 未暴露单位 → 用 `seconds`（终端用户最直观；ms 易误填）。
- **call**：轮询 `ctx.signal.aborted`（每 100ms tick）；
  - 中断（steering 软中断 abort 'interrupt' 或 ESC user-cancel）→ 立即返回 `已中断等待（已过 N 秒）`；
  - 自然完成 → 返回 `已等待 N 秒`。
- **`isReadOnly=true`** → 进 loop 只读并发批（`loop.ts:282-288` CONCURRENCY=5）= 对齐 CC `isConcurrencySafe=true`，可与其他只读工具并发。
- **`needsPermission: () => false`**（纯等待无副作用，无需审批）。
- **`workspacePaths`/`deniablePaths` 不实现**（无路径）。
- **描述本地化（中文，对齐 deepcode 风格）**，照搬 CC 但**删/改不适用行**：
  - ❌ 删 `<tick>` check-in 行（deepcode 无 tick 注入层）；
  - ✅ 保留「优于 Bash(sleep)：不占用 shell 进程」（真实优势）；
  - ✅ 保留「用户随时可中断」「可与其他工具并发」「每次唤醒一次 API 调用，缓存 5 分钟过期需权衡」。
- **注册**：`src/tools/index.ts:16` `allTools` 追加 `sleepTool`。
- **测试计数**：`test/tools.registry.test.ts` 工具数 11→12，列表加 `'Sleep'`（按字母序）。
- **GLOBAL_SUBAGENT_DENY 不加**（`src/tools/agentTypes.ts:17`）——纯等待，子代理可用。

### 测试
- 纯逻辑单测（`test/tools.sleep.test.ts`）：① 自然完成返回文案 + 实际近似时长（用 fake timer，断言 ≥ N 秒未真睡）② signal 已 abort → 立即返回中断文案 ③ 中途 abort → 返回中断 + 已过秒数 ④ 上限校验（>3600 schema 拒绝）⑤ 注册计数断言更新。
- 纯逻辑，**免真机冒烟**（但本批与 tips 同冒烟，会顺带在真机跑一次 Sleep 验证可打断）。

---

## 件 B：5.10 Spinner tips 轮播

### CC 真实机制（逐字实读）
- **按会话计数（`numStartups`）冷却去重，非时间轮播。**
- tip 结构：`{ id, content, cooldownSessions, isRelevant(ctx) }`。
- 去重存储：`config.tipsHistory = { [tipId]: lastSessionNumber }`。
- 选择算法（`UC1`/`FC1`/`eEq`）：
  1. `filter(isRelevant(ctx))`；
  2. `filter(numStartups - tipsHistory[id] >= cooldownSessions)`（未显示过 = `Infinity` 最高优先）；
  3. 从合格集随机选一个；
  4. 显示后 `tipsHistory[id] = numStartups` 持久化。
- 配置覆盖：`spinnerTipsOverride = { tips?: string[], excludeDefault?: boolean }`（自定义 tip cooldown=0/恒 relevant）。
- CC 真实 tip 示例（8 条）：new-user-warmup / plan-mode-for-complex-tasks / default-permission-mode-config / git-worktrees / color-when-multi-clauding / terminal-setup / shift-enter / memory-command。

### deepcode 现状 gap
- **无 `numStartups` 式持久会话计数器**（grep 确认，仅有 per-session id + fireSessionStart('startup')）。→ **需新增持久计数字段**，每次 TUI startup +1。

### deepcode 落地
- **新建 `src/tui/tips.ts`（纯逻辑，核心）**：
  - `interface Tip { id; content: string; cooldownSessions: number; isRelevant(ctx): boolean }`；
  - `DEFAULT_TIPS`：本地化 deepcode 功能（中文，~8 条，见下「Tip 文案草案」）；
  - `selectTip(ctx: { startupCount; tipsHistory; override? }): Tip | null`（照搬 CC 算法：relevance → cooldown → 随机；override.excludeDefault 时仅自定义）；
  - `recordTipShown(id, startupCount, tipsHistory): tipsHistory'`（纯函数返回新对象，调用方持久化）。
  - **随机**：注意 harness 限制无 `Math.random` 的是 workflow 脚本环境；**生产代码 `src/` 可用 `Math.random`**（仅 workflow DSL 禁用）。selectTip 随机选合格集即可。
- **config（`src/config.ts` Settings 接口）新增**：
  - `startupCount?: number`（持久会话计数，user scope，startup +1）；
  - `tipsHistory?: Record<string, number>`（去重历史，user scope）；
  - `spinnerTips?: boolean`（开关，默认 `true`）；
  - `spinnerTipsOverride?: { tips?: string[]; excludeDefault?: boolean }`（对齐 CC）。
  - **均非 DANGEROUS_TOP_KEYS**（纯 UX/非安全敏感）。
  - 提供 `bumpStartupCount()` / `recordTip(id)` 持久化辅助（参照现有 user settings 读写 `loadRawUserSettings`/`saveRawUserSettings`）。
- **startup 递增**：在 TUI 启动路径（`useChat.ts` `fireSessionStart('startup')` 附近，或 `tui/index.tsx`）调 `bumpStartupCount()` 一次。
- **选 tip 时机**（见下「待确认决策 D2」）：默认 = **每会话启动时选一条**（CC 最忠实），整会话固定显示。
- **`Spinner.tsx`**：加可选 `tip?: string` prop；渲染优先级 **`hookLabel` > 常规 spinner 行**，**tip 作为 spinner 行下方一条 dim 文本**（不挤占 verb/elapsed/token 状态行）。
  - 渲染：`💡 {tip}`（dim 色），仅 busy 且有 tip 时显示。
- **useChat**：`ChatState` 加 `currentTip?: string`；startup 时 `selectTip` 一次 + `recordTip`，存入 state。
- **双 App 接线（铁律）**：`App.tsx:285` + `FullscreenApp.tsx:314` 两处 `<Spinner .../>` 同步加 `tip={state.currentTip}`。

### Tip 文案草案（本地化 deepcode，~8 条；最终在 plan 定稿）
| id | content（中文） | cooldown | isRelevant |
|----|------|------|------|
| new-user-warmup | 从小功能或 bug 修复开始，让 deepcode 先给计划，再核对它的改动 | 3 | startupCount < 10 |
| plan-mode | 复杂任务先按 Shift+Tab 进 Plan 模式，让它先规划再动手 | 5 | 恒 true |
| git-worktree | 用 EnterWorktree 在隔离工作树里并行跑多条任务，互不干扰 | 10 | 恒 true |
| model-switch | 用 /model 在 DeepSeek / GLM 各档之间切换 | 10 | 恒 true |
| memory | 用 /memory 查看和管理 deepcode 的跨会话记忆 | 15 | 恒 true |
| fork-rename | 用 /fork 复制会话试不同思路，用 /rename 起名区分 | 10 | 恒 true |
| steering | deepcode 干活时直接打字回车即可补充/转向，无需打断 | 8 | 恒 true |
| compact | 上下文变长时用 /compact 压缩，保留要点继续干 | 12 | 恒 true |

### 测试
- 纯逻辑单测（`test/tips.test.ts`）：① 未显示过的 tip 优先（cooldown=Infinity）② 冷却期内被过滤 ③ isRelevant=false 被过滤 ④ override.excludeDefault 仅返回自定义 ⑤ recordTipShown 写入正确 session 号 ⑥ 全部被过滤时返回 null。
- Spinner 组件测试（ink-testing-library）：tip prop 渲染 + hookLabel 优先级。
- config 读写持久化单测。

---

## 待确认决策（开 plan 前）

- **D1（Sleep 单位/上限）**：input `seconds` 正整数 ≤ 3600。建议采纳。
- **D2（tips 显示节奏）— 已定 = (a) 每会话一条固定（最忠实 CC，rotation 跨会话发生）**。用户拍板。
  - 实现：startup 时 `selectTip` 一次 + `recordTip`，存 `state.currentTip`，整会话不变。
  - 否决 (b) 每 turn 重选、(c) 单 spinner 内定时跑马灯。
- **D3（tip 位置）**：spinner 行**下方独立 dim 行** `💡 …` ✅ 推荐（不挤状态行）；备选 = 附到 spinner 同行尾。
- **D4（`<tick>` check-in）**：本批 Sleep **不实现** tick 注入（deepcode 无调度层）；将来若做 autonomous loop 再补。建议采纳。

---

## 范围红线（本批不做）
- 不做 Sleep 的 `<tick>` 周期 check-in 注入（无调度层）。
- 不做 tips 的「相关性」复杂谓词全集（仅 startupCount 阈值 + 恒 true 两类，够用）。
- 不碰其余 7 件 SKIP（后续批次）。
