import { describe, it, expect } from 'vitest'
import { parseWebSearchConfig } from '../src/config.js'

describe('parseWebSearchConfig', () => {
  it('解析 bocha/tavily apiKey', () => {
    expect(parseWebSearchConfig({ bocha: { apiKey: 'sk-x' }, tavily: { apiKey: 'tvly-y' } }))
      .toEqual({ bocha: { apiKey: 'sk-x' }, tavily: { apiKey: 'tvly-y' } })
  })
  it('保留 provider 字段（向后兼容，不使用）', () => {
    expect(parseWebSearchConfig({ provider: 'bocha', bocha: { apiKey: 'sk-x' } }))
      .toEqual({ provider: 'bocha', bocha: { apiKey: 'sk-x' } })
  })
  it('apiKey 非字符串/空 → 丢该源', () => {
    expect(parseWebSearchConfig({ bocha: { apiKey: '' }, tavily: { apiKey: 7 } })).toBeUndefined()
  })
  it('只配一源', () => {
    expect(parseWebSearchConfig({ tavily: { apiKey: 'tvly-y' } })).toEqual({ tavily: { apiKey: 'tvly-y' } })
  })
  it('非对象 → undefined', () => {
    expect(parseWebSearchConfig(undefined)).toBeUndefined()
    expect(parseWebSearchConfig('x')).toBeUndefined()
    expect(parseWebSearchConfig([1])).toBeUndefined()
  })
})
