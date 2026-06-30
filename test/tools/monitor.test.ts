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
