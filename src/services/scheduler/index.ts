// src/services/scheduler/index.ts
import crypto from 'node:crypto'
import type { ScheduledEntry, CronJob, SchedulerDeps } from './types.js'
import { nextFire, jitterMs, roundUpToMinute, JITTER } from './cron.js'
import { createSentinelResolver } from './sentinel.js'
import { loadDurable, saveDurable, acquireLock, releaseLock } from './store.js'

export const KEEPALIVE_MS = 1_200_000  // 20min 兜底
export const KEEPALIVE_BUDGET = 1
export const WAKEUP_TICK_LINE = '（自主循环 tick）'
const TICK_MS = 10_000

const ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz'
export function genId(prefix: string, rand: (n: number) => Buffer = crypto.randomBytes): string {
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
  private _scheduledThisTurn = false
  private _reloading = false

  constructor(private deps: SchedulerDeps) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(Date.now()), TICK_MS)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    releaseLock(this.deps.cwd())  // idempotent (safe even if no lock was acquired)
  }

  list(): ScheduledEntry[] { return [...this.entries] }

  cancel(id: string): boolean {
    const i = this.entries.findIndex(e => e.id === id)
    if (i < 0) return false
    const [removed] = this.entries.splice(i, 1)
    if (removed.kind === 'cron' && removed.durable) this.persist(this.deps.cwd())
    return true
  }

  reload(cwd: string, now = Date.now()): void {
    let loaded
    try {
      if (!acquireLock(cwd, process.pid, now)) return
      loaded = loadDurable(cwd, now)
    } catch { return /* cwd not accessible */ }
    this._reloading = true
    try {
      for (const j of loaded.jobs) { j.nextFireAt = 0; this.addCron(j) }
    } finally {
      this._reloading = false
    }
    this.persist(cwd)  // single persist after re-arming all durable jobs
    // 错过的 one-shot 不直接 fire（会并发 runTurn），而是 push 为即时到期条目，
    // 让序列化 tick 一次一条按序触发。
    for (const j of loaded.missedOneShots) this.entries.push({ ...j, nextFireAt: now })
  }

  persist(cwd: string): void {
    saveDurable(cwd, this.entries.filter((e): e is CronJob => e.kind === 'cron' && e.durable))
  }

  /** ScheduleWakeup 落点。delaySeconds 已在工具层 clamp；此处取整到整分钟。重置 keepalive budget。 */
  scheduleWakeup(clampedSeconds: number, reason: string, prompt: string, now = Date.now()): string {
    const id = genId('k')
    this.entries.push({ id, kind: 'wakeup', fireAt: roundUpToMinute(now, clampedSeconds), prompt, reason })
    this.keepaliveBudget = KEEPALIVE_BUDGET
    this._scheduledThisTurn = true
    return id
  }

  /** 重置哨兵首发状态（新循环开始时调用）。kind 省略则两种都重置。 */
  resetLoopPreamble(kind?: 'cron' | 'dynamic'): void { this.resolver.reset(kind) }

  /** 消费并重置"本轮已调用 ScheduleWakeup"标志。useChat 在 runTurn 末调用。 */
  consumeScheduled(): boolean {
    const v = this._scheduledThisTurn
    this._scheduledThisTurn = false
    return v
  }

  addCron(job: CronJob, now = Date.now()): void {
    if (job.nextFireAt === 0) {
      const n = nextFire(job.cron, new Date(now))
      job.nextFireAt = n ? n.getTime() + jitterMs(job.id, this.periodMs(job.cron), job.recurring) : Infinity
    }
    this.entries.push(job)
    if (job.durable && !this._reloading) this.persist(this.deps.cwd())
  }

  /** turn 末模型未重新调度时调：武装一个兜底 wakeup；budget 耗尽则不武装（循环结束）。 */
  onTurnEndedWithoutReschedule(now = Date.now()): void {
    if (this.keepaliveBudget <= 0) return
    this.keepaliveBudget--
    const id = genId('k')
    this.entries.push({ id, kind: 'wakeup', fireAt: now + KEEPALIVE_MS, prompt: '<<autonomous-loop-dynamic>>', reason: 'keepalive' })
  }

  /** 中央 tick：每次至多触发一条到期条目（序列化，防多 runTurn 并发竞争 session 状态）。
   *  顶部 isIdle 守卫确保上一 turn 结束前不抢跑；未触发的条目留待下个 10s tick。 */
  tick(now: number): void {
    if (!this.deps.isIdle()) return
    const due = this.entries.filter(e => (e.kind === 'wakeup' ? e.fireAt : e.nextFireAt) <= now)
    for (const e of due) {
      if (e.kind === 'wakeup') {
        this.cancel(e.id)
        this.deps.fire(WAKEUP_TICK_LINE, this.resolver.resolve(e.prompt))
        return
      } else {
        const agedOut = e.recurring && (now - e.createdAt) >= JITTER.recurringMaxAgeMs
        if (!e.recurring || agedOut) {
          this.cancel(e.id)
          this.deps.fire('（定时任务 tick）', this.resolver.resolve(e.prompt))
          return
        }
        this.deps.fire('（定时任务 tick）', this.resolver.resolve(e.prompt))
        const n = nextFire(e.cron, new Date(now))
        e.nextFireAt = n ? n.getTime() + jitterMs(e.id, this.periodMs(e.cron), true) : Infinity
        return
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
