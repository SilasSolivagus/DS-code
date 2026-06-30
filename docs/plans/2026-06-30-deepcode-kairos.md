# 7.2 Kairos 自主循环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 CC v2.1.193 的自主长跑能力 1:1 复刻进 deepcode：会话内 scheduler 子系统 + ScheduleWakeup/Monitor/CronCreate/List/Delete/TaskStop/PushNotification 工具 + `/loop` 命令 + 双哨兵自主循环 + doneMeansMerged。

**Architecture:** 新 `src/services/scheduler/` 子系统（会话绑定，单中央 tick，idle 门触发）承载时间驱动调度（wakeup + cron），经现有 `runTurn` 注入；Monitor 骑 `src/tasks.ts` 现有 task-notification 轨道（`kind:'monitor'` 逐行事件）。不引入 7.3 daemon。

**Tech Stack:** TypeScript (ESM, `.js` import 后缀)、zod schema、vitest、ink TUI。无新增第三方依赖（cron matcher 手写）。

**Spec:** `docs/specs/2026-06-30-deepcode-kairos-design.md`（含 verbatim CC 文本附录 A/B）。

## Global Constraints

- 对齐基准 **CC v2.1.193**；bundle 在 `/private/tmp/claude-501/-Users-silas-loop/36f6a12f-cbfe-48aa-b6cd-5b7c873ba2bb/scratchpad/cc-latest/package/claude`（如已清，verbatim 文本见 spec 附录 A）。
- ESM：所有相对 import 带 `.js` 后缀。
- 工具实现镜像 `src/tools/sleep.ts` 形态（`Tool<typeof schema>`，`isReadOnly`、`needsPermission`、`call(input, ctx)`）。
- **不调** `Date.now()`/`Math.random()` 于纯逻辑模块的核心函数——一律注入 `now`/`rand`（比照 `tasks.ts:75,194` 的 `rand`/`now` 注入），保证可测 + 确定性。
- 新增工具必须：①加入 `src/tools/index.ts` 的 `allTools` ②更新 `test/tools.registry.test.ts` 计数断言 ③视情加入 `GLOBAL_SUBAGENT_DENY`（`src/tools/agentTypes.ts:19`）。
- 常量 verbatim（bundle 实证）：ScheduleWakeup clamp `[60,3600]`；Monitor `timeout_ms` 默认 `300000`/max `3600000`、批 `200`ms、令牌桶容量 `10`/+1 每 `2000`ms/持续超 `30000`ms 自动停、per-line 截 `500`/批截 `3000`；jitter `recurringFrac=0.5`/`recurringCapMs=1800000`/`oneShotMaxMs=90000`/`recurringMaxAgeMs=604800000`(7天)。
- durable 路径：`<cwd>/.deepcode/scheduled_tasks.json` + `<cwd>/.deepcode/scheduled_tasks.lock`（项目级，1:1 CC，无信任门——用户拍板）。
- 提交 trailer：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。分支 `feat/kairos`（spec 已提交 `c4b670d`）。
- 每完成一阶段做一次真机冒烟（glm-5.2），不可省（项目铁律）。

---

## 阶段总览

- **Phase 0**（基建纯逻辑）：types + cron matcher。无副作用，TDD 重。
- **Phase 1**（循环之心）：sentinel resolver + SchedulerService + ScheduleWakeup + `/loop` 接线 + keepalive。交付：`/loop <prompt>` 自起步可跑。
- **Phase 2**（cron 调度）：durable store + CronCreate/List/Delete + 重启重加。交付：`/loop 5m`、durable cron 跨重启。
- **Phase 3**（事件流）：tasks.ts 扩 `kind` + Monitor + TaskStop。交付：Monitor 逐行事件 + 可停。
- **Phase 4**（收口）：PushNotification + doneMeansMerged 变体门控 + 全量注册/计数/子代理 deny sweep + 真机冒烟。

每阶段末一次冒烟；Phase 1/2/3 各自独立可测。

---

# Phase 0 — 基建纯逻辑

### Task 1: scheduler 类型定义

**Files:**
- Create: `src/services/scheduler/types.ts`

**Interfaces:**
- Produces: `WakeupEntry`、`CronJob`、`ScheduledEntry`、`SchedulerDeps`、`SentinelKind`

- [ ] **Step 1: 写类型文件**

```typescript
// src/services/scheduler/types.ts

/** 一次性会话内唤醒（ScheduleWakeup 产生）。用绝对 fireAt 表达，比 CC 的派生日级 cron 更稳健，行为等价。 */
export interface WakeupEntry {
  id: string
  kind: 'wakeup'
  fireAt: number          // 绝对触发时刻 ms（已取整到整分钟）
  prompt: string          // 透传 prompt，可为哨兵 <<autonomous-loop-dynamic>>
  reason: string
}

/** cron 调度（CronCreate 产生）。 */
export interface CronJob {
  id: string
  kind: 'cron'
  cron: string            // 5-field 本地 tz
  prompt: string          // 透传 prompt，可为哨兵 <<autonomous-loop>>
  recurring: boolean
  durable: boolean
  createdAt: number
  nextFireAt: number      // 缓存的下次触发 ms（含 jitter），tick 比对用
}

export type ScheduledEntry = WakeupEntry | CronJob

/** 哨兵种类：runtime 区分两条自主循环路径，永不互换。 */
export type SentinelKind = 'cron' | 'dynamic'

/** SchedulerService 从宿主（useChat）注入的回调。 */
export interface SchedulerDeps {
  /** 当前是否空闲（= !busy）。busy 时 tick 推迟触发。 */
  isIdle: () => boolean
  /** 触发：把 prompt 作为自动 user 轮注入（caller 接 runTurn）。 */
  fire: (displayLine: string, prompt: string) => void
  /** 当前 cwd（durable 文件定位）。 */
  cwd: () => string
  /** doneMeansMerged 设置读取（哨兵 preamble 变体选择）。 */
  doneMeansMerged: () => boolean
}
```

- [ ] **Step 2: 提交**

```bash
git add src/services/scheduler/types.ts
git commit -m "feat(kairos): scheduler 类型定义

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 5-field cron matcher（纯逻辑）

**Files:**
- Create: `src/services/scheduler/cron.ts`
- Test: `test/services/scheduler/cron.test.ts`

**Interfaces:**
- Produces:
  - `parseCron(expr: string): number[][] | null`
  - `cronMatches(expr: string, d: Date): boolean`
  - `nextFire(expr: string, after: Date): Date | null`
  - `clampDelaySeconds(s: number): number`
  - `roundUpToMinute(now: number, delaySeconds: number): number`
  - `jitterMs(id: string, periodMs: number, recurring: boolean): number`
  - 常量 `JITTER`

- [ ] **Step 1: 写失败测试**

```typescript
// test/services/scheduler/cron.test.ts
import { describe, it, expect } from 'vitest'
import { parseCron, cronMatches, nextFire, clampDelaySeconds, roundUpToMinute, jitterMs } from '../../../src/services/scheduler/cron.js'

describe('parseCron', () => {
  it('解析 5 字段通配/数值/范围/步进/列表', () => {
    expect(parseCron('* * * * *')).not.toBeNull()
    expect(parseCron('30 9 * * *')![0]).toEqual([30])
    expect(parseCron('30 9 * * *')![1]).toEqual([9])
    expect(parseCron('0 */6 * * *')![1]).toEqual([0, 6, 12, 18])
    expect(parseCron('0 9 * * 1-5')![4]).toEqual([1, 2, 3, 4, 5])
    expect(parseCron('0,30 9 * * *')![0]).toEqual([0, 30])
  })
  it('字段数错/越界返回 null', () => {
    expect(parseCron('* * * *')).toBeNull()
    expect(parseCron('60 * * * *')).toBeNull()
    expect(parseCron('* 24 * * *')).toBeNull()
    expect(parseCron('abc * * * *')).toBeNull()
  })
})

describe('cronMatches', () => {
  it('匹配本地时间各字段', () => {
    const d = new Date(2026, 5, 30, 9, 30, 0) // 2026-06-30 09:30 周二
    expect(cronMatches('30 9 * * *', d)).toBe(true)
    expect(cronMatches('30 9 * * 2', d)).toBe(true)  // dow 2=周二
    expect(cronMatches('30 9 30 6 *', d)).toBe(true)
    expect(cronMatches('31 9 * * *', d)).toBe(false)
  })
  it('dow 0 与 7 均为周日', () => {
    const sun = new Date(2026, 5, 28, 9, 0, 0) // 周日
    expect(cronMatches('0 9 * * 0', sun)).toBe(true)
    expect(cronMatches('0 9 * * 7', sun)).toBe(true)
  })
})

describe('nextFire', () => {
  it('返回严格晚于 after 的最早匹配', () => {
    const after = new Date(2026, 5, 30, 9, 30, 30)
    const n = nextFire('0 10 * * *', after)!
    expect(n.getHours()).toBe(10)
    expect(n.getMinutes()).toBe(0)
    expect(n.getTime()).toBeGreaterThan(after.getTime())
  })
  it('当前分钟已过则跳到下一匹配（不重复触发同一分钟）', () => {
    const after = new Date(2026, 5, 30, 9, 30, 0)
    const n = nextFire('30 9 * * *', after)!
    expect(n.getDate()).toBe(1) // 次日 7-01
  })
})

describe('clampDelaySeconds', () => {
  it('钳到 [60,3600]', () => {
    expect(clampDelaySeconds(10)).toBe(60)
    expect(clampDelaySeconds(99999)).toBe(3600)
    expect(clampDelaySeconds(300)).toBe(300)
    expect(clampDelaySeconds(NaN)).toBe(60)
  })
})

describe('roundUpToMinute', () => {
  it('取整到下一整分钟', () => {
    const now = new Date(2026, 5, 30, 9, 30, 15).getTime()
    const at = roundUpToMinute(now, 60) // +60s=09:31:15 → 向上取整 09:32:00
    const d = new Date(at)
    expect(d.getSeconds()).toBe(0)
    expect(d.getMinutes()).toBe(32)
  })
})

describe('jitterMs', () => {
  it('确定性：同 id 同周期同结果，且在界内', () => {
    const a = jitterMs('w12345678', 3600_000, true)
    const b = jitterMs('w12345678', 3600_000, true)
    expect(a).toBe(b)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThanOrEqual(1800_000) // recurringCapMs
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/services/scheduler/cron.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 cron.ts**

```typescript
// src/services/scheduler/cron.ts

export const JITTER = {
  recurringFrac: 0.5,
  recurringCapMs: 1_800_000,   // 30min
  oneShotMaxMs: 90_000,        // 90s
  recurringMaxAgeMs: 604_800_000, // 7天
} as const

const BOUNDS: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]

/** 解析单字段成允许值数组。支持 * / N / N-M / a,b,c / */K（及组合）。越界/非法返回 null。 */
function parseField(raw: string, lo: number, hi: number): number[] | null {
  const out = new Set<number>()
  for (const part of raw.split(',')) {
    let step = 1
    let body = part
    const slash = part.indexOf('/')
    if (slash >= 0) {
      const s = Number(part.slice(slash + 1))
      if (!Number.isInteger(s) || s <= 0) return null
      step = s
      body = part.slice(0, slash)
    }
    let from = lo, to = hi
    if (body === '*') { /* 全域 */ }
    else if (body.includes('-')) {
      const [a, b] = body.split('-')
      from = Number(a); to = Number(b)
      if (!Number.isInteger(from) || !Number.isInteger(to)) return null
    } else {
      const n = Number(body)
      if (!Number.isInteger(n)) return null
      from = to = n
    }
    if (from < lo || to > hi || from > to) return null
    for (let v = from; v <= to; v += step) out.add(v)
  }
  return [...out].sort((a, b) => a - b)
}

/** 5 字段 → [minutes,hours,doms,months,dows]；非法（字段数/越界/语法）返回 null。 */
export function parseCron(expr: string): number[][] | null {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const parsed: number[][] = []
  for (let i = 0; i < 5; i++) {
    const f = parseField(fields[i], BOUNDS[i][0], BOUNDS[i][1])
    if (f === null) return null
    parsed.push(f)
  }
  return parsed
}

export function cronMatches(expr: string, d: Date): boolean {
  const p = parseCron(expr)
  if (!p) return false
  const dow = d.getDay() // 0=周日
  const dowOk = p[4].includes(dow) || (dow === 0 && p[4].includes(7)) || (p[4].includes(0) && dow === 7)
  return p[0].includes(d.getMinutes())
    && p[1].includes(d.getHours())
    && p[2].includes(d.getDate())
    && p[3].includes(d.getMonth() + 1)
    && dowOk
}

/** 严格晚于 after 的最早匹配（分钟粒度）。最多扫 366 天，无匹配返回 null。 */
export function nextFire(expr: string, after: Date): Date | null {
  if (!parseCron(expr)) return null
  const t = new Date(after.getTime())
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1) // 从下一整分钟起
  const limit = 366 * 24 * 60
  for (let i = 0; i < limit; i++) {
    if (cronMatches(expr, t)) return new Date(t.getTime())
    t.setMinutes(t.getMinutes() + 1)
  }
  return null
}

export function clampDelaySeconds(s: number): number {
  if (Number.isNaN(s)) return 60
  if (s === Infinity) return 3600
  if (s === -Infinity) return 60
  return Math.max(60, Math.min(3600, Math.round(s)))
}

/** now + delaySeconds 后向上取整到下一整分钟，返回绝对 ms。 */
export function roundUpToMinute(now: number, delaySeconds: number): number {
  const target = now + delaySeconds * 1000
  const d = new Date(target)
  if (d.getSeconds() !== 0 || d.getMilliseconds() !== 0) {
    d.setSeconds(0, 0)
    d.setMinutes(d.getMinutes() + 1)
  }
  return d.getTime()
}

/** 确定性 jitter（CC「deterministic jitter」）：从 id 哈希派生，落 [0, cap]。 */
export function jitterMs(id: string, periodMs: number, recurring: boolean): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  const cap = recurring
    ? Math.min(periodMs * JITTER.recurringFrac, JITTER.recurringCapMs)
    : JITTER.oneShotMaxMs
  return cap <= 0 ? 0 : h % Math.floor(cap)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/services/scheduler/cron.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/scheduler/cron.ts test/services/scheduler/cron.test.ts
git commit -m "feat(kairos): 5-field cron matcher + clamp/round/jitter 纯逻辑

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# Phase 1 — 循环之心

### Task 3: 双哨兵 resolver

**Files:**
- Create: `src/services/scheduler/sentinel.ts`
- Test: `test/services/scheduler/sentinel.test.ts`

**Interfaces:**
- Consumes: `SentinelKind`(Task 1)
- Produces:
  - 常量 `SENTINEL_CRON='<<autonomous-loop>>'`、`SENTINEL_DYNAMIC='<<autonomous-loop-dynamic>>'`
  - `isSentinel(p: string): boolean`
  - `createSentinelResolver(opts: { doneMeansMerged: () => boolean }): { resolve(prompt: string): string; reset(): void }`

- [ ] **Step 1: 写失败测试**

```typescript
// test/services/scheduler/sentinel.test.ts
import { describe, it, expect } from 'vitest'
import { isSentinel, createSentinelResolver, SENTINEL_CRON, SENTINEL_DYNAMIC } from '../../../src/services/scheduler/sentinel.js'

describe('isSentinel', () => {
  it('识别两哨兵，非哨兵 false', () => {
    expect(isSentinel(SENTINEL_CRON)).toBe(true)
    expect(isSentinel(SENTINEL_DYNAMIC)).toBe(true)
    expect(isSentinel('普通 prompt')).toBe(false)
  })
})

describe('resolver', () => {
  it('非哨兵原样透传', () => {
    const r = createSentinelResolver({ doneMeansMerged: () => false })
    expect(r.resolve('做事 X')).toBe('做事 X')
  })
  it('首发含完整 preamble，后续只短 tick', () => {
    const r = createSentinelResolver({ doneMeansMerged: () => false })
    const first = r.resolve(SENTINEL_DYNAMIC)
    const second = r.resolve(SENTINEL_DYNAMIC)
    expect(first).toContain('# Autonomous loop check')
    expect(first).toContain('Autonomous loop tick (dynamic pacing)')
    expect(second).not.toContain('# Autonomous loop check')
    expect(second).toContain('Autonomous loop tick (dynamic pacing)')
  })
  it('cron 哨兵用 cron 短 tick（不提 ScheduleWakeup）', () => {
    const r = createSentinelResolver({ doneMeansMerged: () => false })
    r.resolve(SENTINEL_CRON) // 首发
    const tick = r.resolve(SENTINEL_CRON)
    expect(tick).toContain('# Autonomous loop tick')
    expect(tick).toContain('recurring cron will fire the next tick')
  })
  it('doneMeansMerged=true 选变体 B（先扩范围再停）', () => {
    const r = createSentinelResolver({ doneMeansMerged: () => true })
    expect(r.resolve(SENTINEL_DYNAMIC)).toContain('broaden scope once before considering stopping')
  })
  it('doneMeansMerged=false 选变体 A（安静就停）', () => {
    const r = createSentinelResolver({ doneMeansMerged: () => false })
    expect(r.resolve(SENTINEL_DYNAMIC)).toContain('do one quick CI/threads check and stop in a single line')
  })
  it('reset 后重新首发', () => {
    const r = createSentinelResolver({ doneMeansMerged: () => false })
    r.resolve(SENTINEL_DYNAMIC)
    r.reset()
    expect(r.resolve(SENTINEL_DYNAMIC)).toContain('# Autonomous loop check')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/services/scheduler/sentinel.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 sentinel.ts**（preamble/tick 文本 verbatim 照搬 spec 附录 A）

```typescript
// src/services/scheduler/sentinel.ts
// 文本 1:1 照搬 CC v2.1.193（spec 附录 A，bundle 实证）。

export const SENTINEL_CRON = '<<autonomous-loop>>'
export const SENTINEL_DYNAMIC = '<<autonomous-loop-dynamic>>'

export function isSentinel(p: string): boolean {
  return p === SENTINEL_CRON || p === SENTINEL_DYNAMIC
}

const PREAMBLE_HEAD =
  `# Autonomous loop check\n` +
  `The current conversation is your highest-signal source — re-read the transcript above, since everything there is something the user was actively engaged with. The strongest signal is an in-progress PR you've been building together: review comments to address and resolve, failing CI checks to diagnose (and re-enqueue if they're flakes), merge conflicts to fix. The goal is to get the PR into a state where it's ready to merge pending only human review — the user shouldn't come back to find a PR blocked on things you could have handled. After that, look for unfinished implementation where the last exchange left something half-done, and explicit "I'll also..." or "next I'll..." commitments the conversation made and didn't honor. Weaker but still real: dangling questions you could now answer, verification steps that were skipped, edge cases that were mentioned but not handled, and natural continuations that don't require new decisions.`

// 变体 A（默认 / 安静就停）
const PREAMBLE_TAIL_QUIET =
  `If you see earlier autonomous checks in this conversation, adjust your scope accordingly. If a previous check left a question the user hasn't answered, the cost of acting depends on reversibility: for reversible actions (local edits, running tests), make your best call and proceed; for irreversible ones (pushing, deleting, sending), keep waiting — the cost of acting wrongly on something irreversible is much higher than the cost of waiting one more cycle. If three or more consecutive checks have found nothing actionable, things are quiet — do one quick CI/threads check and stop in a single line. Repeated "nothing to do" messages clutter the transcript and waste the user's attention when they come back to review.`

// 变体 B（doneMeansMerged / 先扩范围再停）
const PREAMBLE_TAIL_PERSIST =
  `If you see earlier autonomous checks in this conversation, adjust your scope accordingly. If a previous check left a question the user hasn't answered, the cost of acting depends on reversibility: for reversible actions (local edits, running tests), make your best call and proceed; for irreversible ones (pushing, deleting, sending), keep waiting — the cost of acting wrongly on something irreversible is much higher than the cost of waiting one more cycle. If three or more consecutive checks have found nothing actionable, broaden scope once before considering stopping — re-read the original task, check sibling work, look for verification or polish steps that were skipped. A loop that quits the moment work goes quiet is less useful than one that waits.`

const TICK_CRON =
  `# Autonomous loop tick\n` +
  `Run the autonomous check using the loop instructions established earlier in this conversation. If you cannot find them, treat this as a no-op tick. The recurring cron will fire the next tick automatically — do not call ScheduleWakeup from this tick.`

const TICK_DYNAMIC =
  `# Autonomous loop tick (dynamic pacing)\n` +
  `Run the autonomous check using the loop instructions established earlier in this conversation. If you cannot find them, treat this as a no-op tick.\n` +
  `You scheduled this tick via the ScheduleWakeup tool (not a recurring cron). To keep the loop alive, call ScheduleWakeup again at the end of this turn with \`prompt\` set to the literal sentinel \`${SENTINEL_DYNAMIC}\` — otherwise the loop ends after this tick.`

/** 维护 first-fire 状态：首发 prepend preamble，后续只短 tick。reset 清状态（新循环/会话）。 */
export function createSentinelResolver(opts: { doneMeansMerged: () => boolean }) {
  let delivered = false
  return {
    resolve(prompt: string): string {
      if (!isSentinel(prompt)) return prompt
      const tick = prompt === SENTINEL_DYNAMIC ? TICK_DYNAMIC : TICK_CRON
      if (delivered) return tick
      delivered = true
      const tail = opts.doneMeansMerged() ? PREAMBLE_TAIL_PERSIST : PREAMBLE_TAIL_QUIET
      return `${PREAMBLE_HEAD}\n${tail}\n${tick}`
    },
    reset(): void { delivered = false },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/services/scheduler/sentinel.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/scheduler/sentinel.ts test/services/scheduler/sentinel.test.ts
git commit -m "feat(kairos): 双哨兵 resolver（首发 preamble/后续短 tick + doneMeansMerged 变体）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: SchedulerService（注册/tick/idle 门/keepalive）

**Files:**
- Create: `src/services/scheduler/index.ts`
- Test: `test/services/scheduler/scheduler.test.ts`

**Interfaces:**
- Consumes: `ScheduledEntry`/`WakeupEntry`/`CronJob`/`SchedulerDeps`(Task 1)、`nextFire`/`jitterMs`/`roundUpToMinute`/`clampDelaySeconds`(Task 2)、`createSentinelResolver`(Task 3)
- Produces: `class SchedulerService`，方法 `start()`/`stop()`/`scheduleWakeup(delaySeconds,reason,prompt)`/`addCron(job)`/`list()`/`cancel(id)`/`tick(now)`/`onTurnEndedWithoutReschedule()`；常量 `KEEPALIVE_MS=1200000`、`KEEPALIVE_BUDGET=1`

- [ ] **Step 1: 写失败测试**

```typescript
// test/services/scheduler/scheduler.test.ts
import { describe, it, expect, vi } from 'vitest'
import { SchedulerService } from '../../../src/services/scheduler/index.js'

function mk(overrides: Partial<{ idle: boolean; merged: boolean }> = {}) {
  const fired: string[] = []
  let idle = overrides.idle ?? true
  const svc = new SchedulerService({
    isIdle: () => idle,
    fire: (_d, p) => fired.push(p),
    cwd: () => '/tmp/proj',
    doneMeansMerged: () => overrides.merged ?? false,
  })
  return { svc, fired, setIdle: (v: boolean) => (idle = v) }
}

describe('scheduleWakeup', () => {
  it('到期且 idle 触发，解析哨兵', () => {
    const { svc, fired } = mk()
    const now = 1_000_000_000_000
    svc.scheduleWakeup(60, 'r', '<<autonomous-loop-dynamic>>', now)
    svc.tick(now + 60_000)        // 还没到整分钟边界？取整后稍晚
    svc.tick(now + 180_000)       // 充分晚 → 触发
    expect(fired.length).toBe(1)
    expect(fired[0]).toContain('Autonomous loop tick (dynamic pacing)')
  })
  it('busy 时不触发，转 idle 后下个 tick 触发', () => {
    const { svc, fired, setIdle } = mk({ idle: false })
    const now = 1_000_000_000_000
    svc.scheduleWakeup(60, 'r', '做 X', now)
    svc.tick(now + 180_000)
    expect(fired.length).toBe(0)
    setIdle(true)
    svc.tick(now + 200_000)
    expect(fired).toEqual(['做 X'])
  })
  it('wakeup 触发后从队列移除（一次性）', () => {
    const { svc, fired } = mk()
    const now = 1_000_000_000_000
    svc.scheduleWakeup(60, 'r', 'X', now)
    svc.tick(now + 180_000)
    svc.tick(now + 240_000)
    expect(fired.length).toBe(1)
    expect(svc.list().length).toBe(0)
  })
})

describe('keepalive', () => {
  it('turn 末未续 → 武装 1200s 兜底；连续两次不续 → 不再武装（循环结束）', () => {
    const { svc } = mk()
    svc.onTurnEndedWithoutReschedule() // 第一次：武装兜底
    expect(svc.list().some(e => e.kind === 'wakeup')).toBe(true)
    svc.cancel(svc.list()[0].id) // 模拟兜底被清/未续
    svc.onTurnEndedWithoutReschedule() // 第二次：budget 耗尽，不武装
    expect(svc.list().some(e => e.kind === 'wakeup')).toBe(false)
  })
  it('显式 scheduleWakeup 重置 keepalive budget', () => {
    const { svc } = mk()
    const now = 1_000_000_000_000
    svc.onTurnEndedWithoutReschedule()
    svc.scheduleWakeup(60, 'r', 'X', now) // 显式续 → 重置
    svc.onTurnEndedWithoutReschedule()
    expect(svc.list().some(e => e.kind === 'wakeup' && e.reason === 'keepalive')).toBe(true)
  })
})

describe('addCron / recurring', () => {
  it('recurring 触发后重算 nextFireAt（不移除）', () => {
    const { svc, fired } = mk()
    const now = new Date(2026, 5, 30, 9, 29, 30).getTime()
    svc.addCron({ id: 'c1', kind: 'cron', cron: '* * * * *', prompt: 'P', recurring: true, durable: false, createdAt: now, nextFireAt: 0 })
    svc.tick(new Date(2026, 5, 30, 9, 31, 0).getTime())
    expect(fired.length).toBeGreaterThanOrEqual(1)
    expect(svc.list().some(e => e.id === 'c1')).toBe(true)
  })
  it('one-shot 触发后移除', () => {
    const { svc } = mk()
    const now = new Date(2026, 5, 30, 9, 29, 30).getTime()
    svc.addCron({ id: 'c2', kind: 'cron', cron: '* * * * *', prompt: 'P', recurring: false, durable: false, createdAt: now, nextFireAt: 0 })
    svc.tick(new Date(2026, 5, 30, 9, 31, 0).getTime())
    expect(svc.list().some(e => e.id === 'c2')).toBe(false)
  })
  it('recurring 超 7 天 age-out：最终一跑后移除', () => {
    const { svc, fired } = mk()
    const created = new Date(2026, 5, 1, 9, 0, 0).getTime()
    svc.addCron({ id: 'c3', kind: 'cron', cron: '* * * * *', prompt: 'P', recurring: true, durable: false, createdAt: created, nextFireAt: 0 })
    svc.tick(new Date(2026, 5, 30, 9, 31, 0).getTime()) // 29 天后
    expect(fired.length).toBe(1)
    expect(svc.list().some(e => e.id === 'c3')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/services/scheduler/scheduler.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 index.ts**

```typescript
// src/services/scheduler/index.ts
import crypto from 'node:crypto'
import type { ScheduledEntry, CronJob, SchedulerDeps } from './types.js'
import { nextFire, jitterMs, roundUpToMinute, JITTER } from './cron.js'
import { createSentinelResolver } from './sentinel.js'

export const KEEPALIVE_MS = 1_200_000  // 20min 兜底
export const KEEPALIVE_BUDGET = 1
const TICK_MS = 10_000

const ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz'
function genId(prefix: string, rand: (n: number) => Buffer = crypto.randomBytes): string {
  const b = rand(8)
  let s = ''
  for (let i = 0; i < 8; i++) s += ID_CHARS[b[i] % 36]
  return prefix + s
}

export class SchedulerService {
  private entries: ScheduledEntry[] = []
  private timer: NodeJS.Timeout | null = null
  private keepaliveBudget = KEEPALIVE_BUDGET
  private resolver = createSentinelResolver({ doneMeansMerged: () => this.deps.doneMeansMerged() })

  constructor(private deps: SchedulerDeps) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(Date.now()), TICK_MS)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  list(): ScheduledEntry[] { return [...this.entries] }

  cancel(id: string): boolean {
    const i = this.entries.findIndex(e => e.id === id)
    if (i < 0) return false
    this.entries.splice(i, 1)
    return true
  }

  /** ScheduleWakeup 落点。delaySeconds 已在工具层 clamp；此处取整到整分钟。重置 keepalive budget 与哨兵首发态。 */
  scheduleWakeup(clampedSeconds: number, reason: string, prompt: string, now = Date.now()): string {
    const id = genId('k')
    this.entries.push({ id, kind: 'wakeup', fireAt: roundUpToMinute(now, clampedSeconds), prompt, reason })
    this.keepaliveBudget = KEEPALIVE_BUDGET
    if (reason !== 'keepalive') this.resolver.reset()
    return id
  }

  addCron(job: CronJob): void {
    if (job.nextFireAt === 0) {
      const n = nextFire(job.cron, new Date(Date.now()))
      job.nextFireAt = n ? n.getTime() + jitterMs(job.id, this.periodMs(job.cron), job.recurring) : Infinity
    }
    this.entries.push(job)
  }

  /** turn 末模型未重新调度时调：武装一个兜底 wakeup；budget 耗尽则不武装（循环结束）。 */
  onTurnEndedWithoutReschedule(now = Date.now()): void {
    if (this.keepaliveBudget <= 0) return
    this.keepaliveBudget--
    const id = genId('k')
    this.entries.push({ id, kind: 'wakeup', fireAt: now + KEEPALIVE_MS, prompt: '<<autonomous-loop-dynamic>>', reason: 'keepalive' })
  }

  /** 中央 tick：扫全部条目，到期且 idle 则触发。 */
  tick(now: number): void {
    if (!this.deps.isIdle()) return
    const due = this.entries.filter(e => (e.kind === 'wakeup' ? e.fireAt : e.nextFireAt) <= now)
    for (const e of due) {
      if (e.kind === 'wakeup') {
        this.cancel(e.id)
        this.deps.fire('（自主循环 tick）', this.resolver.resolve(e.prompt))
      } else {
        const agedOut = e.recurring && (now - e.createdAt) >= JITTER.recurringMaxAgeMs
        this.deps.fire('（定时任务 tick）', this.resolver.resolve(e.prompt))
        if (!e.recurring || agedOut) { this.cancel(e.id); continue }
        const n = nextFire(e.cron, new Date(now))
        e.nextFireAt = n ? n.getTime() + jitterMs(e.id, this.periodMs(e.cron), true) : Infinity
      }
    }
  }

  /** 估算周期（jitter 用）：取相邻两次 nextFire 差，失败兜底 1 天。 */
  private periodMs(cron: string): number {
    const a = nextFire(cron, new Date(0))
    const b = a ? nextFire(cron, a) : null
    return a && b ? b.getTime() - a.getTime() : 86_400_000
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/services/scheduler/scheduler.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/scheduler/index.ts test/services/scheduler/scheduler.test.ts
git commit -m "feat(kairos): SchedulerService（中央 tick + idle 门 + keepalive + 哨兵解析）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: ScheduleWakeup 工具

**Files:**
- Create: `src/tools/scheduleWakeup.ts`
- Test: `test/tools/scheduleWakeup.test.ts`

**Interfaces:**
- Consumes: `clampDelaySeconds`(Task 2)；运行时由 useChat 注入的单例 `SchedulerService`(Task 4)。工具经模块级 setter 拿 service 句柄（避免改 ToolContext 接口）。
- Produces: `scheduleWakeupTool: Tool`、`setScheduler(svc)`、`getScheduler()`

- [ ] **Step 1: 写失败测试**

```typescript
// test/tools/scheduleWakeup.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { scheduleWakeupTool, setScheduler } from '../../src/tools/scheduleWakeup.js'
import { SchedulerService } from '../../src/services/scheduler/index.js'

function fakeCtx(): any { return { signal: { aborted: false }, cwd: () => '/tmp', isSubagent: false } }

describe('ScheduleWakeup tool', () => {
  let fired: string[]
  beforeEach(() => {
    fired = []
    setScheduler(new SchedulerService({ isIdle: () => true, fire: (_d, p) => fired.push(p), cwd: () => '/tmp', doneMeansMerged: () => false }))
  })
  it('注册 wakeup 并回确认（含取整后时间）', async () => {
    const out = await scheduleWakeupTool.call({ delaySeconds: 120, reason: '等 CI', prompt: '<<autonomous-loop-dynamic>>' }, fakeCtx())
    expect(out).toMatch(/Next wakeup scheduled/)
  })
  it('isReadOnly + 不需权限', () => {
    expect(scheduleWakeupTool.isReadOnly).toBe(true)
    expect(scheduleWakeupTool.needsPermission({} as any)).toBe(false)
  })
  it('无 scheduler（非 /loop 上下文）→ 提示循环已结束，不抛', async () => {
    setScheduler(null)
    const out = await scheduleWakeupTool.call({ delaySeconds: 120, reason: 'r', prompt: 'P' }, fakeCtx())
    expect(out).toMatch(/Wakeup not scheduled/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/tools/scheduleWakeup.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 scheduleWakeup.ts**（描述适配：删 CC 缓存窗口文案，见 spec §7）

```typescript
// src/tools/scheduleWakeup.ts
import { z } from 'zod'
import type { Tool } from './types.js'
import type { SchedulerService } from '../services/scheduler/index.js'
import { clampDelaySeconds } from '../services/scheduler/cron.js'

let scheduler: SchedulerService | null = null
export function setScheduler(svc: SchedulerService | null): void { scheduler = svc }
export function getScheduler(): SchedulerService | null { return scheduler }

const schema = z.object({
  delaySeconds: z.number().describe('多少秒后唤醒续跑（运行时钳到 [60,3600]）'),
  reason: z.string().describe('选择该间隔的一句话理由（写给自己看，落遥测/展示给用户）'),
  prompt: z.string().describe('唤醒时回灌的 /loop prompt；自主循环传字面哨兵 <<autonomous-loop-dynamic>>'),
})

export const scheduleWakeupTool: Tool<typeof schema> = {
  name: 'ScheduleWakeup',
  description:
    '在 /loop 动态模式下安排何时续跑——用户用 /loop（不带间隔）让你自定步长迭代某任务时用。\n\n' +
    '每轮把同一个 /loop prompt 经 `prompt` 传回，下次触发重复该任务。自主 /loop（无用户 prompt）则把字面哨兵 `<<autonomous-loop-dynamic>>` 作为 `prompt` 传入——runtime 在触发时解析回完整自主循环指令。省略本次调用 = 结束循环。\n\n' +
    '别用短间隔轮询你已起的后台工作——harness 跟踪的工作完成时会自动重新唤醒你，轮询是浪费。给一个长兜底（1200s+）让循环在工作挂起/从不通知时仍存活。例外：harness 无法跟踪的外部工作（CI/部署/远程队列），按其状态变化速度选间隔。\n\n' +
    'delaySeconds 运行时钳到 [60,3600]，无需自己钳。空闲心跳无具体信号时默认 1200–1800s。',
  inputSchema: schema,
  isReadOnly: true,
  needsPermission: () => false,
  async call(input) {
    if (!scheduler) {
      return 'Wakeup not scheduled. /loop 动态运行时未开启或循环已达上限——循环已结束，不要再发起。'
    }
    const secs = clampDelaySeconds(input.delaySeconds)
    scheduler.scheduleWakeup(secs, input.reason, input.prompt)
    return `Next wakeup scheduled in ${secs}s. 本轮无更多事可做——触发或 task-notification 到达时 harness 会重新唤醒你。`
  },
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/tools/scheduleWakeup.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/scheduleWakeup.ts test/tools/scheduleWakeup.test.ts
git commit -m "feat(kairos): ScheduleWakeup 工具（描述删 CC 缓存窗口适配 DeepSeek/GLM）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 接线 useChat + `/loop` 命令 + 注册 + 计数

**Files:**
- Modify: `src/tui/useChat.ts`（init 接线 ~957、`/loop` 命令 ~1001 区、dispose ~1487）
- Modify: `src/commands.ts`（加 `LOOP_GUIDANCE` 展开文本）
- Modify: `src/tools/index.ts:17`（allTools 加 scheduleWakeupTool）
- Modify: `src/tools/agentTypes.ts:19`（GLOBAL_SUBAGENT_DENY 加 ScheduleWakeup）
- Modify: `test/tools.registry.test.ts:7`（计数 12→13，加 'ScheduleWakeup'）

**Interfaces:**
- Consumes: `SchedulerService`(Task 4)、`setScheduler`(Task 5)、`isSentinel`(Task 3)
- Produces: `/loop` 命令行为；scheduler 单例在会话生命周期内 start/stop

- [ ] **Step 1: 写 `/loop` 解析失败测试**

```typescript
// test/commands.loop.test.ts
import { describe, it, expect } from 'vitest'
import { parseLoopCommand } from '../src/commands.js'

describe('parseLoopCommand', () => {
  it('有区间 → fixed 模式 + cron', () => {
    expect(parseLoopCommand('/loop 5m 跑测试')).toEqual({ mode: 'fixed', cron: '*/5 * * * *', prompt: '跑测试' })
    expect(parseLoopCommand('/loop 1h 看 PR')).toEqual({ mode: 'fixed', cron: '0 * * * *', prompt: '看 PR' })
  })
  it('无区间有 prompt → dynamic 自起步', () => {
    expect(parseLoopCommand('/loop 持续盯 CI')).toEqual({ mode: 'dynamic', prompt: '持续盯 CI' })
  })
  it('无 prompt → autonomous', () => {
    expect(parseLoopCommand('/loop')).toEqual({ mode: 'autonomous' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/commands.loop.test.ts`
Expected: FAIL

- [ ] **Step 3: 在 `src/commands.ts` 加 `parseLoopCommand` + `LOOP_GUIDANCE`**

```typescript
// src/commands.ts 追加

/** 把 5m/30s/1h/2d 间隔转 5-field cron（近似：分钟级用 */N，小时/天用整点）。 */
function intervalToCron(tok: string): string | null {
  const m = /^(\d+)(s|m|h|d)$/.exec(tok)
  if (!m) return null
  const n = Number(m[1])
  switch (m[2]) {
    case 's': case 'm': return `*/${Math.max(1, n)} * * * *`   // 秒近似为分钟（cron 最小分钟）
    case 'h': return n === 1 ? '0 * * * *' : `0 */${n} * * *`
    case 'd': return n === 1 ? '0 9 * * *' : `0 9 */${n} * *`
    default: return null
  }
}

export type LoopParse =
  | { mode: 'fixed'; cron: string; prompt: string }
  | { mode: 'dynamic'; prompt: string }
  | { mode: 'autonomous' }

export function parseLoopCommand(line: string): LoopParse {
  const rest = line.replace(/^\/loop\b/, '').trim()
  if (!rest) return { mode: 'autonomous' }
  const sp = rest.indexOf(' ')
  const first = sp < 0 ? rest : rest.slice(0, sp)
  const cron = intervalToCron(first)
  if (cron && sp >= 0) return { mode: 'fixed', cron, prompt: rest.slice(sp + 1).trim() }
  return { mode: 'dynamic', prompt: rest }
}

/** /loop 展开成给模型的编排指令（dynamic/autonomous 用；fixed 直接建 cron 无需指令）。 */
export const LOOP_GUIDANCE = {
  dynamic: (prompt: string) =>
    `你正处于 /loop 动态自定步模式。现在执行这个任务：\n\n${prompt}\n\n` +
    `做完本轮后，若任务需要继续，在 turn 末调用 ScheduleWakeup（prompt 设为同一任务文本）安排下次续跑；不需要继续就省略调用结束循环。`,
  autonomous: () =>
    `你正处于自主 /loop 模式。现在立即跑第一次自主检查，然后在 turn 末调用 ScheduleWakeup（prompt 设为字面 \`<<autonomous-loop-dynamic>>\`）保持循环；要停就省略调用。`,
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/commands.loop.test.ts`
Expected: PASS

- [ ] **Step 5: useChat 接线 scheduler**

在 `src/tui/useChat.ts` import 区加：
```typescript
import { SchedulerService } from '../services/scheduler/index.js'
import { setScheduler } from '../tools/scheduleWakeup.js'
import { parseLoopCommand, LOOP_GUIDANCE } from '../commands.js'
```

在 `unsubNotification`（~957）之后加 scheduler 实例化 + start：
```typescript
const scheduler = new SchedulerService({
  isIdle: () => !busy,
  fire: (displayLine, prompt) => { void runTurn(displayLine, prompt) },
  cwd: () => cwd,
  doneMeansMerged: () => loadSettings(cwd).doneMeansMerged === true,
})
setScheduler(scheduler)
scheduler.start()
```
> `loadSettings` 已 import（`src/config.ts`）；`doneMeansMerged` 设置键在 Task 14 加，此处先按可选读取（undefined→false）。

在 `runTurn` 完成处（~938 `busy = false` 之后，`wakeOnNotification()` 一带）补 keepalive 钩子——**仅当本轮处于动态循环**。最小落地：runTurn 末判断「本轮 user 文本是哨兵或 LOOP_GUIDANCE 触发」时，若模型未调用 ScheduleWakeup 则 `scheduler.onTurnEndedWithoutReschedule()`。用一个 `loopActive` 标志跟踪：
```typescript
// runTurn 内：起始处若 userText 含 dynamic guidance/哨兵 → loopActive=true
// 末尾（busy=false 后）：
if (loopActive && !scheduledThisTurn) scheduler.onTurnEndedWithoutReschedule()
scheduledThisTurn = false
```
> `scheduledThisTurn` 由 ScheduleWakeup 工具经 scheduler 回调置位（加 `scheduler` 上一个 `markScheduled()`/`consumeScheduled()` 小标志，或在 fire 路径里记录）。实现者按现有 runTurn 结构择一最小接法。

在 dispose（~1487）加 `scheduler.stop(); setScheduler(null);`。

加 `/loop` 命令处理（在命令 if-cascade，`/help` 之后某处）：
```typescript
if (line === '/loop' || line.startsWith('/loop ')) {
  const p = parseLoopCommand(line)
  if (p.mode === 'fixed') {
    scheduler.addCron({ id: genId('c'), kind: 'cron', cron: p.cron, prompt: p.prompt, recurring: true, durable: false, createdAt: Date.now(), nextFireAt: 0 })
    notice('info', `已建循环：每 ${line.split(' ')[1]} 跑一次。立即跑首轮。`)
    await runTurn(`（/loop 首轮）`, p.prompt)
  } else if (p.mode === 'dynamic') {
    await runTurn('（/loop 自起步）', LOOP_GUIDANCE.dynamic(p.prompt))
  } else {
    await runTurn('（/loop 自主）', LOOP_GUIDANCE.autonomous())
  }
  return
}
```
> `genId` 复用 `generateTaskId` 或本地小工具；cron 的 id 前缀 'c'。

- [ ] **Step 6: 注册工具 + GLOBAL_SUBAGENT_DENY + 计数**

`src/tools/index.ts`：import `scheduleWakeupTool`，加进 `allTools`。
`src/tools/agentTypes.ts:19`：`GLOBAL_SUBAGENT_DENY` 数组加 `'ScheduleWakeup'`。
`test/tools.registry.test.ts`：计数 12→13，sorted 数组加 `'ScheduleWakeup'`。
（若 `agent.test` 有计数断言同步。）

- [ ] **Step 7: 跑全量 + 构建确认绿**

Run: `cd /Users/silas/loop/deepcode && npx vitest run && npx tsc --noEmit`
Expected: PASS（全绿）

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "feat(kairos): /loop 命令 + scheduler 接线 useChat + ScheduleWakeup 注册

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 9: Phase 1 真机冒烟（glm-5.2）**

```bash
cd /Users/silas/loop/deepcode && npm run build && node dist/index.js --model glm-5.2
```
手动验证：①`/loop 持续看一下 ./README.md 有没有该补的，每轮报告一句` → 模型跑一轮 + turn 末调用 ScheduleWakeup（看到「Next wakeup scheduled」）②等下一 tick（或临时把 TICK_MS 调小验证）触发续跑 ③省略调用后循环结束。**冒烟过再进 Phase 2。**
> 跑本地构建用 `node dist/index.js`，**别用全局 `deepcode`**（可能是旧版）。

---

# Phase 2 — cron 调度 + durable

### Task 7: durable store（持久化 + lock + 漏跑补偿 + age-out）

**Files:**
- Create: `src/services/scheduler/store.ts`
- Test: `test/services/scheduler/store.test.ts`

**Interfaces:**
- Consumes: `CronJob`(Task 1)
- Produces:
  - `storePathFor(cwd: string): string`、`lockPathFor(cwd: string): string`
  - `loadDurable(cwd: string, now?: number): { jobs: CronJob[]; missedOneShots: CronJob[] }`
  - `saveDurable(cwd: string, jobs: CronJob[]): void`
  - `acquireLock(cwd: string, pid?: number, now?: number): boolean`
  - `releaseLock(cwd: string): void`

- [ ] **Step 1: 写失败测试**

```typescript
// test/services/scheduler/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { saveDurable, loadDurable, acquireLock, releaseLock, storePathFor } from '../../../src/services/scheduler/store.js'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const job = (id: string, extra: any = {}) => ({ id, kind: 'cron' as const, cron: '0 9 * * *', prompt: 'P', recurring: true, durable: true, createdAt: 1000, nextFireAt: 2000, ...extra })

describe('durable 往返', () => {
  it('save 后 load 拿回 durable job', () => {
    saveDurable(dir, [job('c1')])
    const { jobs } = loadDurable(dir, 3000)
    expect(jobs.map(j => j.id)).toEqual(['c1'])
    expect(fs.existsSync(storePathFor(dir))).toBe(true)
  })
  it('损坏文件不抛，返回空', () => {
    fs.mkdirSync(path.join(dir, '.deepcode'), { recursive: true })
    fs.writeFileSync(storePathFor(dir), '{坏 json')
    expect(loadDurable(dir, 3000)).toEqual({ jobs: [], missedOneShots: [] })
  })
})

describe('漏跑 one-shot 补偿', () => {
  it('non-recurring 且 nextFireAt < now → 进 missedOneShots，不进 jobs', () => {
    saveDurable(dir, [job('one', { recurring: false, nextFireAt: 500 })])
    const { jobs, missedOneShots } = loadDurable(dir, 3000)
    expect(jobs.length).toBe(0)
    expect(missedOneShots.map(j => j.id)).toEqual(['one'])
  })
})

describe('age-out', () => {
  it('recurring 超 7 天直接剔除', () => {
    const created = 1000
    saveDurable(dir, [job('old', { createdAt: created })])
    const { jobs } = loadDurable(dir, created + 8 * 24 * 3600_000)
    expect(jobs.length).toBe(0)
  })
})

describe('lock', () => {
  it('首获成功，重复获（不同 pid，锁新鲜）失败', () => {
    expect(acquireLock(dir, 111, 1000)).toBe(true)
    expect(acquireLock(dir, 222, 1000)).toBe(false)
  })
  it('陈旧锁（超时）可抢占', () => {
    acquireLock(dir, 111, 1000)
    expect(acquireLock(dir, 222, 1000 + 120_000)).toBe(true) // 锁 TTL 内为 false，超 TTL 可抢
  })
  it('release 后可再获', () => {
    acquireLock(dir, 111, 1000)
    releaseLock(dir)
    expect(acquireLock(dir, 222, 1000)).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/services/scheduler/store.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 store.ts**

```typescript
// src/services/scheduler/store.ts
import fs from 'node:fs'
import path from 'node:path'
import type { CronJob } from './types.js'
import { JITTER } from './cron.js'

const LOCK_TTL_MS = 90_000

export function storePathFor(cwd: string): string {
  return path.join(cwd, '.deepcode', 'scheduled_tasks.json')
}
export function lockPathFor(cwd: string): string {
  return path.join(cwd, '.deepcode', 'scheduled_tasks.lock')
}

export function saveDurable(cwd: string, jobs: CronJob[]): void {
  const file = storePathFor(cwd)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const durable = jobs.filter(j => j.durable)
  fs.writeFileSync(file, JSON.stringify({ version: 1, jobs: durable }, null, 2))
}

/** 读 durable：剔除 age-out 的 recurring；non-recurring 已过期者归 missedOneShots 供 catch-up。损坏→空。 */
export function loadDurable(cwd: string, now = Date.now()): { jobs: CronJob[]; missedOneShots: CronJob[] } {
  let raw: any
  try {
    raw = JSON.parse(fs.readFileSync(storePathFor(cwd), 'utf8'))
  } catch {
    return { jobs: [], missedOneShots: [] }
  }
  const all: CronJob[] = Array.isArray(raw?.jobs) ? raw.jobs : []
  const jobs: CronJob[] = []
  const missedOneShots: CronJob[] = []
  for (const j of all) {
    if (j.recurring) {
      if ((now - j.createdAt) >= JITTER.recurringMaxAgeMs) continue // age-out
      jobs.push(j)
    } else {
      if (j.nextFireAt < now) missedOneShots.push(j)
      else jobs.push(j)
    }
  }
  return { jobs, missedOneShots }
}

export function acquireLock(cwd: string, pid = process.pid, now = Date.now()): boolean {
  const file = lockPathFor(cwd)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (cur.pid === pid) { /* 本进程已持有 */ }
    else if (now - cur.at < LOCK_TTL_MS) return false // 新鲜锁，他人持有
  } catch { /* 无锁/坏锁 → 可获 */ }
  fs.writeFileSync(file, JSON.stringify({ pid, at: now }))
  return true
}

export function releaseLock(cwd: string): void {
  try { fs.unlinkSync(lockPathFor(cwd)) } catch { /* 尽力 */ }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/services/scheduler/store.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/scheduler/store.ts test/services/scheduler/store.test.ts
git commit -m "feat(kairos): durable store（持久化+lock+漏跑补偿+age-out）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: CronCreate/CronList/CronDelete 工具 + scheduler 重加接线

**Files:**
- Create: `src/tools/cron.ts`
- Modify: `src/services/scheduler/index.ts`（加 `reload()`、durable 持久化钩子、`releaseLock` on stop）
- Test: `test/tools/cron.test.ts`

**Interfaces:**
- Consumes: `getScheduler`(Task 5)、`parseCron`(Task 2)、store(Task 7)、`SchedulerService.addCron/list/cancel`(Task 4)
- Produces: `cronCreateTool`、`cronListTool`、`cronDeleteTool`；`SchedulerService.reload(cwd)`、`SchedulerService.persist()`

- [ ] **Step 1: 写失败测试**

```typescript
// test/tools/cron.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { cronCreateTool, cronListTool, cronDeleteTool } from '../../src/tools/cron.js'
import { setScheduler } from '../../src/tools/scheduleWakeup.js'
import { SchedulerService } from '../../src/services/scheduler/index.js'

let svc: SchedulerService
beforeEach(() => {
  svc = new SchedulerService({ isIdle: () => true, fire: () => {}, cwd: () => '/tmp/p', doneMeansMerged: () => false })
  setScheduler(svc)
})

describe('CronCreate', () => {
  it('合法 cron → 注册并回 id', async () => {
    const out = await cronCreateTool.call({ cron: '0 9 * * *', prompt: 'P', recurring: true, durable: false }, {} as any)
    expect(out).toMatch(/已安排/)
    expect(svc.list().some(e => e.kind === 'cron')).toBe(true)
  })
  it('非法 cron → 拒绝不注册', async () => {
    const out = await cronCreateTool.call({ cron: '99 * * * *', prompt: 'P', recurring: true, durable: false }, {} as any)
    expect(out).toMatch(/无效/)
    expect(svc.list().length).toBe(0)
  })
})

describe('CronList/CronDelete', () => {
  it('list 列出，delete 删除', async () => {
    await cronCreateTool.call({ cron: '0 9 * * *', prompt: 'P', recurring: true, durable: false }, {} as any)
    const id = svc.list()[0].id
    expect(await cronListTool.call({}, {} as any)).toContain(id)
    await cronDeleteTool.call({ id }, {} as any)
    expect(svc.list().length).toBe(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/tools/cron.test.ts`
Expected: FAIL

- [ ] **Step 3: 在 `SchedulerService` 加 reload/persist**（`src/services/scheduler/index.ts`）

```typescript
// import 顶部加：
import { loadDurable, saveDurable, acquireLock, releaseLock } from './store.js'

// 类内加方法：
reload(cwd: string, now = Date.now()): void {
  if (!acquireLock(cwd, process.pid, now)) return // 他会话持锁，不重复触发
  const { jobs, missedOneShots } = loadDurable(cwd, now)
  for (const j of jobs) { j.nextFireAt = 0; this.addCron(j) }
  // 漏跑 one-shot：立即作为到期任务补触发一次
  for (const j of missedOneShots) this.deps.fire('（错过的定时任务补跑）', j.prompt)
}

persist(cwd: string): void {
  saveDurable(cwd, this.entries.filter((e): e is import('./types.js').CronJob => e.kind === 'cron' && (e as any).durable))
}

// stop() 末尾加：releaseLock(this.deps.cwd())
```
addCron / cancel 末尾在 durable 变更后调 `this.persist(this.deps.cwd())`（仅当涉及 durable job）。

- [ ] **Step 4: 实现 cron.ts 工具**

```typescript
// src/tools/cron.ts
import { z } from 'zod'
import crypto from 'node:crypto'
import type { Tool } from './types.js'
import { getScheduler } from './scheduleWakeup.js'
import { parseCron } from '../services/scheduler/cron.js'

function genCronId(): string {
  const b = crypto.randomBytes(8); const C = '0123456789abcdefghijklmnopqrstuvwxyz'
  let s = ''; for (let i = 0; i < 8; i++) s += C[b[i] % 36]; return 'c' + s
}

const createSchema = z.object({
  cron: z.string().describe('5 字段 cron（本地时区）：分 时 日 月 周。如 "0 9 * * *"=每天 9 点'),
  prompt: z.string().describe('每次触发时入队的 prompt；自主循环传字面 <<autonomous-loop>>'),
  recurring: z.boolean().default(true).describe('true=每次匹配都触发（7 天后自动过期）；false=下次匹配触发一次后删除'),
  durable: z.boolean().default(false).describe('true=持久化到 <cwd>/.deepcode/scheduled_tasks.json 跨重启；false=仅本会话'),
})

export const cronCreateTool: Tool<typeof createSchema> = {
  name: 'CronCreate',
  description:
    '安排一个 prompt 在未来时间入队——按 cron 周期重复，或一次性。\n\n' +
    '标准 5 字段 cron，用户本地时区。recurring 任务 7 天后自动过期（最后触发一次再删，告知用户该 7 天上限）。durable:true 持久化到 .deepcode/scheduled_tasks.json 跨重启恢复，仅在用户明确要求长期保留时用。\n\n' +
    '只在 REPL 空闲（非查询中）触发。要实时盯日志/进程用 Monitor，不是 CronCreate。',
  inputSchema: createSchema,
  isReadOnly: true,
  needsPermission: () => false,
  async call(input) {
    const svc = getScheduler()
    if (!svc) return 'CronCreate 不可用（无活动会话调度器）。'
    if (!parseCron(input.cron)) return `cron 表达式无效：${input.cron}（需 5 字段，各字段在界内）`
    const id = genCronId()
    svc.addCron({ id, kind: 'cron', cron: input.cron, prompt: input.prompt, recurring: input.recurring, durable: input.durable, createdAt: Date.now(), nextFireAt: 0 })
    const note = input.recurring ? '（recurring，7 天后自动过期）' : '（一次性）'
    return `已安排 ${id}：${input.cron} ${note}${input.durable ? ' [durable]' : ''}`
  },
}

const listSchema = z.object({})
export const cronListTool: Tool<typeof listSchema> = {
  name: 'CronList',
  description: '列出本会话经 CronCreate 安排的所有 cron 任务（含 durable）。',
  inputSchema: listSchema,
  isReadOnly: true,
  needsPermission: () => false,
  async call() {
    const svc = getScheduler()
    if (!svc) return '（无活动调度器）'
    const crons = svc.list().filter(e => e.kind === 'cron')
    if (crons.length === 0) return '（无 cron 任务）'
    return crons.map((e: any) => `${e.id} ${e.cron} ${e.recurring ? 'recurring' : 'once'}${e.durable ? ' durable' : ''} → ${e.prompt.slice(0, 40)}`).join('\n')
  },
}

const delSchema = z.object({ id: z.string().describe('CronCreate 返回的任务 id') })
export const cronDeleteTool: Tool<typeof delSchema> = {
  name: 'CronDelete',
  description: '取消一个之前用 CronCreate 安排的 cron 任务。',
  inputSchema: delSchema,
  isReadOnly: true,
  needsPermission: () => false,
  async call(input) {
    const svc = getScheduler()
    if (!svc) return '（无活动调度器）'
    return svc.cancel(input.id) ? `已删除 ${input.id}` : `未找到 ${input.id}`
  },
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/tools/cron.test.ts test/services/scheduler/`
Expected: PASS

- [ ] **Step 6: 注册 + 计数 + 接线 reload**

`src/tools/index.ts`：加 `cronCreateTool, cronListTool, cronDeleteTool`。
`src/tools/agentTypes.ts:19`：`GLOBAL_SUBAGENT_DENY` 加 `'CronCreate','CronList','CronDelete'`。
`test/tools.registry.test.ts`：计数 13→16，加三名。
`src/tui/useChat.ts`：scheduler `start()` 后调 `scheduler.reload(cwd)`；`/loop` fixed 模式如需 durable 由模型走 CronCreate（命令本身建 session-only cron）。

- [ ] **Step 7: 跑全量 + 构建**

Run: `cd /Users/silas/loop/deepcode && npx vitest run && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "feat(kairos): CronCreate/List/Delete 工具 + durable reload 接线

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 9: Phase 2 真机冒烟（glm-5.2）**

验证：①`CronCreate` 建一个 `*/1 * * * *` durable 任务 → 看 `.deepcode/scheduled_tasks.json` 落盘 ②等 1-2 分钟触发一次 ③退出重启 `node dist/index.js` → reload 恢复，CronList 看到 ④若启动期错过 one-shot → 补跑提示。**冒烟过再进 Phase 3。**

---

# Phase 3 — Monitor + TaskStop

### Task 9: tasks.ts 扩 `kind` 判别符

**Files:**
- Modify: `src/tasks.ts:11-31`（BackgroundTask 加 `kind?`）、`src/tasks.ts:87-96`（toNotification 按 kind 加标签）
- Test: `test/tasks.kind.test.ts`

**Interfaces:**
- Produces: `BackgroundTask.kind?: 'monitor'`；toNotification 对 monitor 加「监控」标签

- [ ] **Step 1: 写失败测试**

```typescript
// test/tasks.kind.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { registerTask, enqueueNotification, drainNotifications, clearAllTasks, formatNotification } from '../src/tasks.js'

beforeEach(() => clearAllTasks())

describe('monitor kind 通知', () => {
  it('kind:monitor 通知 summary 带监控标签 + 事件文本进 result（否则 toNotification 丢 description）', () => {
    const t = { id: 'm1', type: 'local_bash', kind: 'monitor', status: 'running', description: 'EVENT 1', startTime: 0, outputFile: '/x', outputOffset: 0, notified: false } as any
    registerTask(t)
    enqueueNotification(t)
    const n = drainNotifications()
    expect(n[0].summary).toContain('监控')
    expect(n[0].result).toBe('EVENT 1') // 事件行文本必须可见
  })
})
```

- [ ] **Step 2: 跑确认失败** → `npx vitest run test/tasks.kind.test.ts`

- [ ] **Step 3: 改 tasks.ts**

`BackgroundTask` 接口加（`src/tasks.ts:30` 附近）：
```typescript
  /** monitor 专有：标记流式监控任务（跳过单次完成通知器 + capMs 上限） */
  kind?: 'monitor'
```
`toNotification`（`src/tasks.ts:87-96`）改为按 kind 优先 + monitor 把事件文本（`description`）放进 `result`（否则通知体丢失逐行内容——`toNotification` 默认不输出 `description`）：
```typescript
function toNotification(task: BackgroundTask): TaskNotification {
  const kind = task.kind === 'monitor' ? '监控'
    : task.type === 'local_agent' ? '子代理' : task.type === 'local_hook' ? '命令钩子' : task.type === 'local_workflow' ? '工作流' : '命令'
  return {
    id: task.id,
    status: task.status,
    summary: `${kind}${statusZh(task.status)}`,
    result: task.kind === 'monitor' ? task.description
      : (task.type === 'local_agent' || task.type === 'local_hook' || task.type === 'local_workflow') ? task.result : undefined,
    outputFile: task.type === 'local_bash' && task.kind !== 'monitor' ? task.outputFile : undefined,
  }
}
```

- [ ] **Step 4: 跑确认通过** → `npx vitest run test/tasks.kind.test.ts`

- [ ] **Step 5: 提交**
```bash
git add src/tasks.ts test/tasks.kind.test.ts
git commit -m "feat(kairos): tasks.ts 加 kind:monitor 判别符

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Monitor 工具（逐行事件 + 令牌桶限流）

**Files:**
- Create: `src/tools/monitor.ts`
- Test: `test/tools/monitor.test.ts`

**Interfaces:**
- Consumes: `registerTask/updateTask/enqueueNotification/generateTaskId`(tasks.ts)、`killProcessTree`(tasks.ts)
- Produces: `monitorTool`；纯逻辑 `class TokenBucket`（容量 10/+1 每 2000ms/超 30000ms 持续 → 自动停）

- [ ] **Step 1: 写失败测试（令牌桶纯逻辑 + 行→事件）**

```typescript
// test/tools/monitor.test.ts
import { describe, it, expect } from 'vitest'
import { TokenBucket, MONITOR } from '../../src/tools/monitor.js'

describe('TokenBucket', () => {
  it('容量内放行，耗尽后抑制', () => {
    const tb = new TokenBucket(0)
    for (let i = 0; i < MONITOR.bucketCapacity; i++) expect(tb.allow(0)).toBe(true)
    expect(tb.allow(0)).toBe(false) // 第 11 个抑制
  })
  it('随时间补充令牌', () => {
    const tb = new TokenBucket(0)
    for (let i = 0; i < MONITOR.bucketCapacity; i++) tb.allow(0)
    expect(tb.allow(MONITOR.refillMs)).toBe(true) // 2s 后补 1
  })
  it('持续超速超过 30s → shouldStop', () => {
    const tb = new TokenBucket(0)
    for (let t = 0; t < MONITOR.overflowKillMs + 1000; t += 100) tb.allow(t) // 持续猛灌
    expect(tb.shouldStop(MONITOR.overflowKillMs + 1000)).toBe(true)
  })
})
```

- [ ] **Step 2: 跑确认失败** → `npx vitest run test/tools/monitor.test.ts`

- [ ] **Step 3: 实现 monitor.ts**

```typescript
// src/tools/monitor.ts
import { z } from 'zod'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Tool } from './types.js'
import { TASKS_DIR } from '../config.js'
import { registerTask, updateTask, enqueueNotification, generateTaskId, killProcessTree } from '../tasks.js'

export const MONITOR = {
  batchMs: 200,
  bucketCapacity: 10,
  refillMs: 2000,
  overflowKillMs: 30_000,
  perLineCap: 500,
  defaultTimeoutMs: 300_000,
  maxTimeoutMs: 3_600_000,
} as const

/** 令牌桶：容量 capacity，每 refillMs 补 1。allow 抑制时累计 overflow 起点，持续超 overflowKillMs → shouldStop。 */
export class TokenBucket {
  private tokens = MONITOR.bucketCapacity
  private last: number
  private overflowSince: number | null = null
  constructor(startTs: number) { this.last = startTs }
  allow(now: number): boolean {
    const refill = Math.floor((now - this.last) / MONITOR.refillMs)
    if (refill > 0) { this.tokens = Math.min(MONITOR.bucketCapacity, this.tokens + refill); this.last = now }
    if (this.tokens > 0) { this.tokens--; this.overflowSince = null; return true }
    if (this.overflowSince === null) this.overflowSince = now
    return false
  }
  shouldStop(now: number): boolean {
    return this.overflowSince !== null && (now - this.overflowSince) >= MONITOR.overflowKillMs
  }
}

const schema = z.object({
  command: z.string().describe('shell 命令/脚本。每行 stdout = 一个事件；退出结束监控'),
  description: z.string().describe('监控对象的简短描述（出现在通知里）'),
  timeout_ms: z.number().min(1000).default(MONITOR.defaultTimeoutMs).describe(`超时 kill（默认 ${MONITOR.defaultTimeoutMs}，max ${MONITOR.maxTimeoutMs}）。persistent 时忽略`),
  persistent: z.boolean().default(false).describe('会话生命周期内常驻（无超时）。用 TaskStop 停'),
})

export const monitorTool: Tool<typeof schema> = {
  name: 'Monitor',
  description:
    '启动后台监控，从长跑脚本流式取事件。每行 stdout 是一个事件——你继续干活，通知到达聊天。\n\n' +
    '200ms 内的多行合并为一条通知。脚本在与 Bash 相同的 shell 环境跑，退出结束监控（报退出码），超时被 kill。persistent:true 用于会话级监控（盯 PR/日志尾），靠 TaskStop 或会话结束停。\n\n' +
    '过滤要狠（grep --line-buffered）：产生过多事件的监控会被自动停止。',
  inputSchema: schema,
  isReadOnly: true,           // 不写文件；但 spawn shell——比照 bash 后台不需逐次审批
  needsPermission: () => false,
  async call(input, ctx) {
    if ((ctx as any).isSubagent) return 'Monitor 不可在子代理中启动。'
    const timeout = input.persistent ? undefined : Math.min(input.timeout_ms, MONITOR.maxTimeoutMs)
    const id = generateTaskId('local_bash')
    fs.mkdirSync(TASKS_DIR, { recursive: true })
    const outputFile = path.join(TASKS_DIR, `${id}.log`)
    const ws = fs.createWriteStream(outputFile)
    const child = spawn('bash', ['-c', input.command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    registerTask({ id, type: 'local_bash', kind: 'monitor', status: 'running', description: input.description, startTime: Date.now(), outputFile, outputOffset: 0, notified: false, command: input.command, child } as any)

    const bucket = new TokenBucket(Date.now())
    let buf = ''
    let suppressed = 0
    const emit = (line: string): void => {
      const now = Date.now()
      if (bucket.shouldStop(now)) {
        updateTask(id, { status: 'killed' } as any)
        killProcessTree(child, 'SIGTERM')
        enqueueNotification({ id, type: 'local_bash', kind: 'monitor', status: 'killed', description: `[Monitor 已停——输出过多，${suppressed} 个事件被抑制。换更狠的过滤]`, startTime: 0, outputFile, outputOffset: 0, notified: false } as any)
        return
      }
      if (!bucket.allow(now)) { suppressed++; return }
      const trimmed = line.slice(0, MONITOR.perLineCap)
      ws.write(line + '\n')
      enqueueNotification({ id, type: 'local_bash', kind: 'monitor', status: 'running', description: `Monitor「${input.description}」: ${trimmed}`, startTime: 0, outputFile, outputOffset: 0, notified: false } as any)
    }
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) emit(line) }
    })
    child.once('exit', code => {
      ws.end()
      updateTask(id, { status: code === 0 ? 'completed' : 'failed', endTime: Date.now() } as any)
      enqueueNotification({ id, type: 'local_bash', kind: 'monitor', status: code === 0 ? 'completed' : 'failed', description: `Monitor「${input.description}」结束（退出码 ${code}）`, startTime: 0, outputFile, outputOffset: 0, notified: false } as any)
    })
    if (timeout !== undefined) setTimeout(() => { if (child.exitCode === null) killProcessTree(child, 'SIGTERM') }, timeout).unref?.()
    return `Monitor 已启动 id=${id}（${input.persistent ? '常驻' : `${timeout}ms 超时`}）。事件将作为 task-notification 到达。用 TaskStop ${id} 停止。`
  },
}
```
> 注：每次 `enqueueNotification` 传新的 `notified:false` 对象——因 monitor 要发多条事件（不同于一次性任务的去重语义），不复用注册表里那条记录。实现时确保 `enqueueNotification` 的 check-and-set 不卡住流式（它读传入对象的 `notified`，传入 false 即放行）。

- [ ] **Step 4: 跑确认通过** → `npx vitest run test/tools/monitor.test.ts`

- [ ] **Step 5: 提交**
```bash
git add src/tools/monitor.ts test/tools/monitor.test.ts
git commit -m "feat(kairos): Monitor 工具（逐行事件 + 令牌桶限流）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: TaskStop 工具

**Files:**
- Create: `src/tools/taskStop.ts`
- Test: `test/tools/taskStop.test.ts`

**Interfaces:**
- Consumes: `getTask/updateTask/killProcessTree`(tasks.ts)、`getScheduler`(可选，停 cron)
- Produces: `taskStopTool`

- [ ] **Step 1: 写失败测试**

```typescript
// test/tools/taskStop.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { taskStopTool } from '../../src/tools/taskStop.js'
import { registerTask, getTask, clearAllTasks } from '../../src/tasks.js'

beforeEach(() => clearAllTasks())

describe('TaskStop', () => {
  it('停一个 running 任务 → 状态 killed', async () => {
    registerTask({ id: 'b1', type: 'local_bash', status: 'running', description: 'x', startTime: 0, outputFile: '/x', outputOffset: 0, notified: false, child: { pid: undefined, kill() {} } } as any)
    const out = await taskStopTool.call({ task_id: 'b1' }, {} as any)
    expect(out).toMatch(/已停止/)
    expect(getTask('b1')!.status).toBe('killed')
  })
  it('未知 id → 提示未找到', async () => {
    expect(await taskStopTool.call({ task_id: 'nope' }, {} as any)).toMatch(/未找到/)
  })
})
```

- [ ] **Step 2: 跑确认失败** → `npx vitest run test/tools/taskStop.test.ts`

- [ ] **Step 3: 实现 taskStop.ts**

```typescript
// src/tools/taskStop.ts
import { z } from 'zod'
import type { Tool } from './types.js'
import { getTask, updateTask, killProcessTree } from '../tasks.js'
import { getScheduler } from './scheduleWakeup.js'

const schema = z.object({ task_id: z.string().describe('要停止的后台任务 id（含 Monitor / cron）') })

export const taskStopTool: Tool<typeof schema> = {
  name: 'TaskStop',
  description: '按 id 停止一个运行中的后台任务（Monitor、后台 Bash、cron）。',
  inputSchema: schema,
  isReadOnly: true,
  needsPermission: () => false,
  async call(input) {
    const t = getTask(input.task_id)
    if (t) {
      if (t.status === 'running') {
        if (t.type === 'local_bash') killProcessTree(t.child, 'SIGTERM')
        else t.abortController?.abort()
        updateTask(t.id, { status: 'killed', endTime: Date.now() })
      }
      return `已停止 ${input.task_id}`
    }
    if (getScheduler()?.cancel(input.task_id)) return `已停止 ${input.task_id}`
    return `未找到 ${input.task_id}`
  },
}
```

- [ ] **Step 4: 跑确认通过** → `npx vitest run test/tools/taskStop.test.ts`

- [ ] **Step 5: 注册 + 计数 + deny**
`src/tools/index.ts`：加 `monitorTool, taskStopTool`。
`src/tools/agentTypes.ts`：`GLOBAL_SUBAGENT_DENY` 加 `'Monitor','TaskStop'`。
`test/tools.registry.test.ts`：计数 16→18，加二名。

- [ ] **Step 6: 跑全量 + 构建** → `npx vitest run && npx tsc --noEmit` → PASS

- [ ] **Step 7: 提交**
```bash
git add -A
git commit -m "feat(kairos): TaskStop 工具 + Monitor/TaskStop 注册

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: Phase 3 真机冒烟（glm-5.2）**
验证：①`Monitor` 盯 `bash -c 'for i in 1 2 3; do echo EVENT $i; sleep 1; done'` → 三条 task-notification 逐条到达 ②`Monitor persistent` 盯 `tail -f` 类 → `TaskStop <id>` 能停 ③令牌桶：猛灌 → 自动停 + 抑制通知。**冒烟过再进 Phase 4。**

---

# Phase 4 — PushNotification + doneMeansMerged + 收口

### Task 12: PushNotification 工具（OSC 桌面通知）

**Files:**
- Create: `src/tools/pushNotification.ts`
- Test: `test/tools/pushNotification.test.ts`

**Interfaces:**
- Produces: `pushNotificationTool`；纯逻辑 `oscNotification(message: string, term?: string): string`（返回要写 stdout 的转义序列）

- [ ] **Step 1: 写失败测试**

```typescript
// test/tools/pushNotification.test.ts
import { describe, it, expect } from 'vitest'
import { oscNotification, pushNotificationTool } from '../../src/tools/pushNotification.js'

describe('oscNotification', () => {
  it('iTerm/默认 → OSC 9', () => {
    expect(oscNotification('hi', 'iTerm.app')).toBe(']9;hi')
  })
  it('Ghostty → OSC 777', () => {
    expect(oscNotification('hi', 'ghostty')).toContain(']777;notify;')
  })
  it('未知终端 → 至少含响铃兜底', () => {
    expect(oscNotification('hi', undefined)).toContain('')
  })
})

describe('PushNotification tool', () => {
  it('截断到 200 字 + 返回已发提示', async () => {
    const out = await pushNotificationTool.call({ message: 'x'.repeat(300), status: 'proactive' }, {} as any)
    expect(out).toMatch(/已发送|通知/)
  })
})
```

- [ ] **Step 2: 跑确认失败** → `npx vitest run test/tools/pushNotification.test.ts`

- [ ] **Step 3: 实现 pushNotification.ts**

```typescript
// src/tools/pushNotification.ts
import { z } from 'zod'
import type { Tool } from './types.js'

const BEL = ''

/** 按终端类型选 OSC 转义。iTerm2→OSC 9；Ghostty→OSC 777；Kitty→OSC 99；未知→响铃兜底。 */
export function oscNotification(message: string, term = process.env.TERM_PROGRAM): string {
  const t = (term ?? '').toLowerCase()
  if (t.includes('ghostty')) return `]777;notify;deepcode;${message}${BEL}`
  if (t.includes('kitty')) return `]99;;${message}${BEL}`
  // iTerm2 与默认：OSC 9（含响铃兜底语义）
  return `]9;${message}${BEL}`
}

const schema = z.object({
  message: z.string().describe('通知正文，<200 字，一行，无 markdown。开头放用户要处理的事'),
  status: z.literal('proactive'),
})

export const pushNotificationTool: Tool<typeof schema> = {
  name: 'PushNotification',
  description:
    '在用户终端发桌面通知，把注意力从别处拉到本会话——这是成本，故宁可不发。\n\n' +
    '别为常规进度/刚问完还在看的事/快速完成发。在用户可能已离开且有值得回来的事时发，或用户明确要求时发。<200 字一行。',
  inputSchema: schema,
  isReadOnly: true,
  needsPermission: () => false,
  async call(input) {
    const msg = input.message.slice(0, 200).replace(/\n/g, ' ')
    try { process.stdout.write(oscNotification(msg)) } catch { /* 尽力 */ }
    return `已发送桌面通知：${msg}`
  },
}
```

- [ ] **Step 4: 跑确认通过** → `npx vitest run test/tools/pushNotification.test.ts`

- [ ] **Step 5: 提交**
```bash
git add src/tools/pushNotification.ts test/tools/pushNotification.test.ts
git commit -m "feat(kairos): PushNotification 工具（OSC 桌面通知，手机 N/A）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: doneMeansMerged 设置键 + 收口注册/计数/构建

**Files:**
- Modify: `src/config.ts`（`Settings` 加 `doneMeansMerged?: boolean` + parse）
- Modify: `src/tools/index.ts`（加 `pushNotificationTool`）
- Modify: `src/tools/agentTypes.ts`（`GLOBAL_SUBAGENT_DENY` 加 `'PushNotification'`）
- Modify: `test/tools.registry.test.ts`（计数 18→19，加 'PushNotification'）
- Test: `test/config.doneMeansMerged.test.ts`

**Interfaces:**
- Consumes: 已在 useChat 接 `doneMeansMerged: () => loadSettings(cwd).doneMeansMerged === true`(Task 6)；sentinel 变体已据此选(Task 3)
- Produces: `Settings.doneMeansMerged`

- [ ] **Step 1: 写失败测试**

```typescript
// test/config.doneMeansMerged.test.ts
import { describe, it, expect } from 'vitest'
import { parseSettings } from '../src/config.js' // 若无导出，测 loadSettings 经临时文件

describe('doneMeansMerged 设置', () => {
  it('布尔解析，缺省 undefined', () => {
    expect(parseSettings({ doneMeansMerged: true }).doneMeansMerged).toBe(true)
    expect(parseSettings({}).doneMeansMerged).toBeUndefined()
    expect(parseSettings({ doneMeansMerged: 'yes' }).doneMeansMerged).toBeUndefined()
  })
})
```
> 若 `config.ts` 无 `parseSettings` 导出，改测 `loadSettings` 经临时 settings.json，断言读回。实现者按现有 config 解析结构（参考 `spinnerTips` 在 `config.ts:141` 的解析方式）对齐。

- [ ] **Step 2: 跑确认失败** → `npx vitest run test/config.doneMeansMerged.test.ts`

- [ ] **Step 3: config.ts 加键**
`Settings` 接口（`src/config.ts:81` `spinnerTips` 附近）加：
```typescript
  /** 自主循环停止准则：true=干到 PR merge-ready/武装了 cron 或 Monitor/交付自包含下一步才停（对齐 CC doneMeansMerged，选 autonomous-loop preamble 变体 B） */
  doneMeansMerged?: boolean
```
解析处（`config.ts:141` `spinnerTips` 解析旁）加：
```typescript
    doneMeansMerged: typeof raw?.doneMeansMerged === 'boolean' ? raw.doneMeansMerged : undefined,
```
> `doneMeansMerged` **不**进 `DANGEROUS_TOP_KEYS`（它只选 preamble 文案变体，非危险能力）——保持项目级可设。

- [ ] **Step 4: 跑确认通过** → `npx vitest run test/config.doneMeansMerged.test.ts`

- [ ] **Step 5: 注册 PushNotification + 计数**
`src/tools/index.ts`：`allTools` 加 `pushNotificationTool`。
`src/tools/agentTypes.ts`：`GLOBAL_SUBAGENT_DENY` 加 `'PushNotification'`。
`test/tools.registry.test.ts`：计数 18→19，sorted 加 `'PushNotification'`。最终 19 个工具的 sorted 断言含：`Bash, Config, CronCreate, CronDelete, CronList, Edit, EnterWorktree, ExitPlanMode, ExitWorktree, Glob, Grep, Monitor, NotebookEdit, PushNotification, Read, ScheduleWakeup, Sleep, TaskStop, Write`。

- [ ] **Step 6: 跑全量 + 构建确认绿**

Run: `cd /Users/silas/loop/deepcode && npx vitest run && npx tsc --noEmit && npm run build`
Expected: PASS（全绿）

- [ ] **Step 7: 提交**
```bash
git add -A
git commit -m "feat(kairos): doneMeansMerged 设置键 + PushNotification 注册 + 收口计数

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: Phase 4 + 全量真机冒烟（glm-5.2 端到端）**
依 spec §12 跑四场景：①`/loop` 自起步（ScheduleWakeup 续命 + keepalive 兜底验证）②durable cron 跨重启 + 漏跑补偿 ③Monitor 流 + TaskStop ④`PushNotification` OSC 桌面通知弹出 ⑤设 `doneMeansMerged:true` 验自主循环 preamble 走变体 B（安静时扩范围不轻易停）。冒烟全过后准备 opus 全分支终审 + 合并。

---

## Self-Review（写完对照 spec）

**1. Spec 覆盖**：
- ScheduleWakeup ✅ Task 5 / Monitor ✅ Task 10 / CronCreate·List·Delete ✅ Task 8 / TaskStop ✅ Task 11 / PushNotification ✅ Task 12 / `/loop` ✅ Task 6 / 双哨兵 ✅ Task 3 / keepalive ✅ Task 4 / doneMeansMerged ✅ Task 3+13 / durable+lock+catch-up ✅ Task 7 / Monitor kind ✅ Task 9 / GLOBAL_SUBAGENT_DENY ✅ Task 6/8/11/13 / 计数断言 ✅ 每阶段 / 真机冒烟 ✅ 每 Phase 末。
- 适配（spec §7）：OSC-only push ✅ Task 12 / 删缓存 pull-in ✅ Task 5 描述 / `/loop` 命令展开 ✅ Task 6 / Monitor 无 ws ✅（schema 只 command）/ jitter config 值 ✅ Task 2 / durable 项目级无门 ✅ Task 7。

**2. Placeholder 扫描**：无 TBD/TODO；novel 逻辑均有完整代码；Task 6 的 runTurn keepalive 接法给了具体标志方案（`loopActive`/`scheduledThisTurn`），留实现者按 runTurn 现有结构择一最小接法（非占位，是有界的接线选择）。

**3. 类型一致性**：`SchedulerService` 方法名（`scheduleWakeup`/`addCron`/`list`/`cancel`/`tick`/`onTurnEndedWithoutReschedule`/`reload`/`persist`/`start`/`stop`）跨 Task 4/5/6/8 一致；`CronJob`/`WakeupEntry` 字段跨 Task 1/4/7/8 一致；`setScheduler`/`getScheduler` 跨 Task 5/8/11 一致；`isSentinel`/`createSentinelResolver` 跨 Task 3/4 一致；`MONITOR`/`TokenBucket` 跨 Task 10 一致。

**已知接线点（实现时确认）**：①Task 6 runTurn 的 keepalive 触发标志接法 ②`enqueueNotification` 流式多发：Monitor 每次传 `notified:false` 新对象绕过去重（Task 10 注），需确认现有 `enqueueNotification`（`tasks.ts:108`）对「同 id 多次入队」行为——它按传入对象的 `notified` 判断 + `updateTask(id,{notified:true})` 改注册表，流式场景传入独立对象即可重复入队（实现时加一条针对性测试坐实）。
