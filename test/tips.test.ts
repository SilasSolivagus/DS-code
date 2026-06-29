import { describe, it, expect } from 'vitest'
import { selectTip, recordTipShown, DEFAULT_TIPS } from '../src/tui/tips.js'

describe('tips selectTip', () => {
  it('未显示过的 tip 可被选中（cooldown=Infinity 优先）', () => {
    const tip = selectTip({ startupCount: 1, tipsHistory: {}, rng: () => 0 })
    expect(tip).not.toBeNull()
    expect(DEFAULT_TIPS.some(t => t.id === tip!.id)).toBe(true)
  })

  it('冷却期内的 tip 被过滤', () => {
    // 所有默认 tip 都在上个会话显示过且 cooldown 未到 → 仅极个别可选；构造全冷却
    const history = Object.fromEntries(DEFAULT_TIPS.map(t => [t.id, 100]))
    const tip = selectTip({ startupCount: 101, tipsHistory: history, rng: () => 0 })
    // startupCount-100=1，小于所有 cooldown(>=3) → 全被过滤
    expect(tip).toBeNull()
  })

  it('isRelevant=false 被过滤（new-user-warmup 在 startupCount>=10 不相关）', () => {
    const onlyWarmup = selectTip({ startupCount: 50, tipsHistory: {}, rng: () => 0 })
    // rng=0 选第一个合格项；new-user-warmup 因 startupCount>=10 不相关，不会是它
    expect(onlyWarmup?.id).not.toBe('new-user-warmup')
  })

  it('excludeDefault 时仅返回自定义 tip', () => {
    const tip = selectTip({
      startupCount: 1, tipsHistory: {},
      override: { tips: ['我的提示'], excludeDefault: true }, rng: () => 0,
    })
    expect(tip?.content).toBe('我的提示')
    expect(tip?.id).toBe('custom-0')
  })

  it('全部被过滤返回 null', () => {
    const history = Object.fromEntries(DEFAULT_TIPS.map(t => [t.id, 1000]))
    const tip = selectTip({ startupCount: 1000, tipsHistory: history, rng: () => 0 })
    expect(tip).toBeNull()
  })

  it('rng 决定从合格集选哪个', () => {
    const a = selectTip({ startupCount: 1, tipsHistory: {}, rng: () => 0 })
    const b = selectTip({ startupCount: 1, tipsHistory: {}, rng: () => 0.999 })
    expect(a!.id).not.toBe(b!.id)
  })
})

describe('recordTipShown', () => {
  it('写入当前会话号且不可变', () => {
    const h0 = { x: 1 }
    const h1 = recordTipShown('y', 9, h0)
    expect(h1).toEqual({ x: 1, y: 9 })
    expect(h0).toEqual({ x: 1 }) // 原对象不变
  })
})
