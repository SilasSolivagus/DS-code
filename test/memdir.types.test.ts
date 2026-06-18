import { describe, test, expect } from 'vitest'
import { isMemoryType, MEMORY_TYPES, MEMORY_TYPE_GUIDE } from '../src/memdir/memoryTypes.js'

test('isMemoryType', () => {
  expect(isMemoryType('user')).toBe(true)
  expect(isMemoryType('feedback')).toBe(true)
  expect(isMemoryType('nope')).toBe(false)
  expect(isMemoryType(undefined)).toBe(false)
})
test('四类齐全 + guide 提到四类', () => {
  expect([...MEMORY_TYPES].sort()).toEqual(['feedback', 'project', 'reference', 'user'])
  for (const t of MEMORY_TYPES) expect(MEMORY_TYPE_GUIDE).toContain(t)
})
