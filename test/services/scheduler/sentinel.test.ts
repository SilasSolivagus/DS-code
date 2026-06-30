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
