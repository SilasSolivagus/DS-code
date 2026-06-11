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

  it('未知模型回退到 flash 费率，不抛错', () => {
    expect(costUSD('whatever', 1000, 0, 0)).toBeCloseTo(1000 / 1e6 * 0.14, 8)
  })

  it('全命中时输入近乎免费', () => {
    expect(costUSD('deepseek-v4-flash', 1000, 1000, 0)).toBeCloseTo(0.0000028, 8)
  })
})
