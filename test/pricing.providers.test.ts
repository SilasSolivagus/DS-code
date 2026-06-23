import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

vi.mock('../src/config.js', () => ({ loadSettings: vi.fn(() => ({ provider: 'glm', permissions: { allow: [] }, costWarnCNY: 15, maxToolResultChars: 100000 })) }))
import { costCNY, cacheSavingsCNY } from '../src/pricing.js'
import { __resetProviderCache } from '../src/providers.js'

beforeEach(() => __resetProviderCache())

describe('costCNY 多 provider', () => {
  it('active=glm 时 glm-5.2 成本非零', () => {
    expect(costCNY('glm-5.2', 1_000_000, 0, 0)).toBeGreaterThan(0)
  })
  it('未知 glm 档走 defaultMeta（非零）', () => {
    expect(costCNY('glm-5.3', 1_000_000, 0, 0)).toBeGreaterThan(0)
  })
  it('cacheSavingsCNY glm-5.2 非负', () => {
    expect(cacheSavingsCNY('glm-5.2', 1000)).toBeGreaterThanOrEqual(0)
  })
})
