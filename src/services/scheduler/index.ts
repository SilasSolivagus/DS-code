// src/services/scheduler/index.ts
import crypto from 'node:crypto'
import type { ScheduledEntry, CronJob, SchedulerDeps } from './types.js'
import { nextFire, jitterMs, roundUpToMinute, JITTER } from './cron.js'
import { createSentinelResolver } from './sentinel.js'

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
    this._scheduledThisTurn = true
    if (reason !== 'keepalive') this.resolver.reset()
    return id
  }

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
        this.deps.fire(WAKEUP_TICK_LINE, this.resolver.resolve(e.prompt))
      } else {
        const agedOut = e.recurring && (now - e.createdAt) >= JITTER.recurringMaxAgeMs
        if (!e.recurring || agedOut) {
          this.cancel(e.id)
          this.deps.fire('（定时任务 tick）', this.resolver.resolve(e.prompt))
          continue
        }
        this.deps.fire('（定时任务 tick）', this.resolver.resolve(e.prompt))
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
