import { describe, it, expect } from 'vitest'
import { costUSD } from '../src/pricing.js'

describe('costUSD', () => {
  it('flash：命中/未命中/输出 分别计费', () => {
    // promptTokens=1000（其中命中 800，未命中 200），输出 500
    expect(costUSD('deepseek-v4-flash', 1000, 800, 500)).toBeCloseTo(0.00017024, 8)
  })

  it('pro 用更高费率', () => {
    expect(costUSD('deepseek-v4-pro', 1000, 0, 1000)).toBeCloseTo(0.001305, 8)
  })

  it('未知模型返回 0（非 deepseek 系列计价按 0 估算），不抛错', () => {
    expect(costUSD('whatever', 1000, 0, 0)).toBe(0)
    expect(costUSD('gpt-4o', 10000, 5000, 500)).toBe(0)
  })

  it('全命中时输入近乎免费', () => {
    expect(costUSD('deepseek-v4-flash', 1000, 1000, 0)).toBeCloseTo(0.0000028, 8)
  })
})

import { cacheSavingsUSD } from '../src/pricing.js'

describe('cacheSavingsUSD', () => {
  it('flash：缓存命中省下的金额 = hitTokens × (miss − hit) / 1e6', () => {
    // flash: hit=0.0028, miss=0.14 → 差价 0.1372/Mtok；800 tokens → 0.00010976
    expect(cacheSavingsUSD('deepseek-v4-flash', 800)).toBeCloseTo(0.00010976, 8)
  })

  it('pro：用 pro 的 hit/miss 差价', () => {
    // pro: hit=0.003625, miss=0.435 → 差价 0.431375/Mtok；1000 tokens → 0.000431375
    expect(cacheSavingsUSD('deepseek-v4-pro', 1000)).toBeCloseTo(0.000431375, 9)
  })

  it('未知模型返回 0，不抛错', () => {
    expect(cacheSavingsUSD('gpt-4o', 10000)).toBe(0)
  })

  it('hitTokens=0 → 0', () => {
    expect(cacheSavingsUSD('deepseek-v4-flash', 0)).toBe(0)
  })
})
