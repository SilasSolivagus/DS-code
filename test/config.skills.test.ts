import { describe, it, expect } from 'vitest'
import { parseSkillsConfig } from '../src/config.js'

describe('parseSkillsConfig', () => {
  it('合法 sources：只留 claude/deepcode', () => {
    expect(parseSkillsConfig({ sources: ['deepcode', 'bogus', 'claude'] }))
      .toEqual({ sources: ['deepcode', 'claude'] })
  })
  it('sources 全非法 → 不带 sources（落默认全扫）', () => {
    expect(parseSkillsConfig({ sources: ['bogus', 123] })).toEqual({})
  })
  it('deny：留非空 string 并 trim', () => {
    expect(parseSkillsConfig({ deny: ['  cso ', '', 'ship', 7] }))
      .toEqual({ deny: ['cso', 'ship'] })
  })
  it('listingBudgetChars：正整数才取', () => {
    expect(parseSkillsConfig({ listingBudgetChars: 4000 })).toEqual({ listingBudgetChars: 4000 })
    expect(parseSkillsConfig({ listingBudgetChars: 0 })).toEqual({})
    expect(parseSkillsConfig({ listingBudgetChars: -5 })).toEqual({})
    expect(parseSkillsConfig({ listingBudgetChars: 1.5 })).toEqual({})
    expect(parseSkillsConfig({ listingBudgetChars: 'big' })).toEqual({})
  })
  it('整个对象非法 → undefined', () => {
    expect(parseSkillsConfig(undefined)).toBeUndefined()
    expect(parseSkillsConfig(null)).toBeUndefined()
    expect(parseSkillsConfig('x')).toBeUndefined()
    expect(parseSkillsConfig([1, 2])).toBeUndefined()
  })
  it('空对象 → 空 SkillsConfig（不是 undefined；用于表达「有 skills 配置但全用默认」）', () => {
    expect(parseSkillsConfig({})).toEqual({})
  })
})
