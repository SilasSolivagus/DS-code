import { describe, it, expect } from 'vitest'
import { loadSettings } from '../src/config.js'

describe('settings 默认值', () => {
  it('文件缺失时给出 compactTokens/costWarnUSD 默认值', () => {
    const s = loadSettings()
    expect(s.compactTokens).toBeTypeOf('number')
    expect(s.compactTokens).toBeGreaterThan(0)
    expect(s.costWarnUSD).toBeTypeOf('number')
  })
})
