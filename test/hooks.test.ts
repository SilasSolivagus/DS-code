// test/hooks.test.ts
import { describe, it, expect, vi } from 'vitest'
import { matchesMatcher } from '../src/hooks.js'

describe('matchesMatcher', () => {
  it('undefined / 空串 / * → 恒匹配', () => {
    expect(matchesMatcher(undefined, 'Write')).toBe(true)
    expect(matchesMatcher('', 'Write')).toBe(true)
    expect(matchesMatcher('*', 'Write')).toBe(true)
  })
  it('简单标识符 → 精确匹配', () => {
    expect(matchesMatcher('Write', 'Write')).toBe(true)
    expect(matchesMatcher('Write', 'Edit')).toBe(false)
  })
  it('管道列表 → 多精确或', () => {
    expect(matchesMatcher('Write|Edit', 'Edit')).toBe(true)
    expect(matchesMatcher('Write|Edit', 'Read')).toBe(false)
  })
  it('正则 → 测试', () => {
    expect(matchesMatcher('^Wr.*', 'Write')).toBe(true)
    expect(matchesMatcher('^Ed.*', 'Write')).toBe(false)
  })
  it('非法正则 → false（不抛）', () => {
    expect(matchesMatcher('[invalid(', 'Write')).toBe(false)
  })
})
