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
