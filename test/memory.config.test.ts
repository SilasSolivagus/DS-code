import { describe, test, expect } from 'vitest'
import { parseMemoryConfig, DEFAULT_MEMORY_CONFIG } from '../src/memdir/memoryConfig.js'

test('空/非对象 → 全默认', () => {
  expect(parseMemoryConfig(undefined)).toEqual(DEFAULT_MEMORY_CONFIG)
  expect(parseMemoryConfig('x')).toEqual(DEFAULT_MEMORY_CONFIG)
  expect(parseMemoryConfig({})).toEqual(DEFAULT_MEMORY_CONFIG)
})
test('部分覆盖 + 非法字段丢弃回默认', () => {
  const c = parseMemoryConfig({ enabled: false, extractEveryTurns: 'x', recall: { enabled: true }, dream: { minHours: 1 } })
  expect(c.enabled).toBe(false)
  expect(c.extractEveryTurns).toBe(1) // 非法→默认
  expect(c.recall.enabled).toBe(true)
  expect(c.recall.maxResults).toBe(5) // 未给→默认
  expect(c.dream.minHours).toBe(1)
  expect(c.dream.minSessions).toBe(5)
})
test('默认值正确', () => {
  expect(DEFAULT_MEMORY_CONFIG).toEqual({
    enabled: true, extractEveryTurns: 1,
    recall: { enabled: false, maxResults: 5 },
    sessionMemory: { enabled: true, minInitTokens: 10000, minUpdateTokens: 5000, toolCallsBetween: 3 },
    dream: { enabled: true, minHours: 24, minSessions: 5 },
  })
})
