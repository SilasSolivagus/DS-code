import { describe, it, expect } from 'vitest'
import { costCNY, cacheSavingsCNY } from '../src/pricing.js'

describe('costCNY', () => {
  it('flash：命中/未命中/输出 分别计费（CNY）', () => {
    // flash CNY: hit 0.02, miss 1, out 2。prompt=1000(hit 800,miss 200),out 500
    // = (800*0.02 + 200*1 + 500*2)/1e6 = (16 + 200 + 1000)/1e6 = 0.001216
    expect(costCNY('deepseek-v4-flash', 1000, 800, 500)).toBeCloseTo(0.001216, 8)
  })
  it('未知模型返回 0', () => {
    expect(costCNY('gpt-4o', 10000, 5000, 500)).toBe(0)
  })
})

describe('cacheSavingsCNY', () => {
  it('flash：缓存命中省下 = hitTokens × (miss − hit) / 1e6（CNY）', () => {
    // (1 − 0.02) = 0.98；800 × 0.98 / 1e6 = 0.000784
    expect(cacheSavingsCNY('deepseek-v4-flash', 800)).toBeCloseTo(0.000784, 8)
  })
  it('未知模型 0 / hitTokens 0 → 0', () => {
    expect(cacheSavingsCNY('gpt-4o', 10000)).toBe(0)
    expect(cacheSavingsCNY('deepseek-v4-flash', 0)).toBe(0)
  })
})
