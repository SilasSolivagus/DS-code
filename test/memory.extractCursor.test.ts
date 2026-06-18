import { describe, test, expect } from 'vitest'
import { shouldExtractByThrottle, messagesSince, hasMemoryWritesSince } from '../src/services/memory/extractCursor.js'

test('节流：trailing 恒跑；否则按 everyTurns', () => {
  expect(shouldExtractByThrottle(0, 1, true)).toBe(true)
  expect(shouldExtractByThrottle(1, 1, false)).toBe(true)
  expect(shouldExtractByThrottle(1, 3, false)).toBe(false)
  expect(shouldExtractByThrottle(3, 3, false)).toBe(true)
})

test('messagesSince 取游标后的切片', () => {
  const msgs = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]
  const turns = [1, undefined, 2]
  expect(messagesSince(msgs, turns, 1)).toEqual([{ role: 'user', content: 'c' }])
  expect(messagesSince(msgs, turns, 0).length).toBe(3)
  expect(messagesSince(msgs, turns, 5)).toEqual([])
})

test('hasMemoryWritesSince 检测 memdir 写', () => {
  const md = '/x/memory'
  const withWrite = [{ role: 'assistant', tool_calls: [{ function: { name: 'MemWrite', arguments: '{"file_path":"a.md"}' } }] }]
  expect(hasMemoryWritesSince(withWrite, md)).toBe(true)
  const plainWrite = [{ role: 'assistant', tool_calls: [{ function: { name: 'Write', arguments: '{"file_path":"/x/memory/a.md"}' } }] }]
  expect(hasMemoryWritesSince(plainWrite, md)).toBe(true)
  const noWrite = [{ role: 'assistant', tool_calls: [{ function: { name: 'Read', arguments: '{}' } }] }]
  expect(hasMemoryWritesSince(noWrite, md)).toBe(false)
  const badJson = [{ role: 'assistant', tool_calls: [{ function: { name: 'Write', arguments: 'not json' } }] }]
  expect(hasMemoryWritesSince(badJson, '/x/memory')).toBe(false)
  const noArgs = [{ role: 'assistant', tool_calls: [{ function: { name: 'Write' } }] }]
  expect(hasMemoryWritesSince(noArgs, '/x/memory')).toBe(false)
})
