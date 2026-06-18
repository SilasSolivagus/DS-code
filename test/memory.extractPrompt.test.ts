import { test, expect } from 'vitest'
import { buildExtractPrompt, renderRecentMessages } from '../src/services/memory/extractPrompt.js'

test('renderRecentMessages 拼角色+文本', () => {
  const r = renderRecentMessages([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }])
  expect(r).toContain('hello'); expect(r).toContain('hi')
})
test('renderRecentMessages 过滤空内容', () => {
  expect(renderRecentMessages([{ role: 'user', content: '' }])).toBe('')
  expect(renderRecentMessages([{ role: 'user', content: undefined }])).toBe('')
  expect(renderRecentMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: '' }])).toBe('[user] a')
})
test('buildExtractPrompt 含四类 + 清单 + 禁 grep 源码', () => {
  const p = buildExtractPrompt([{ role: 'user', content: 'X' }], '- [user] a.md: d')
  expect(p).toContain('user'); expect(p).toContain('feedback')
  expect(p).toContain('a.md')
  expect(p).toMatch(/不要.*源码|禁.*grep/)
  expect(p).toContain('MEMORY.md')
})
