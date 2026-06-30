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
