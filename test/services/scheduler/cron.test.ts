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
  it('落在整分钟边界则不前进', () => {
    const base = new Date(2026, 5, 30, 9, 30, 0).getTime()
    expect(roundUpToMinute(base, 60)).toBe(new Date(2026, 5, 30, 9, 31, 0).getTime()) // 09:30:00+60s=09:31:00 整点不再进
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
