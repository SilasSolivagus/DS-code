import { describe, test, expect, vi } from 'vitest'
import { findRelevantMemories } from '../src/memdir/findRelevantMemories.js'

function fakeClient(content: string) {
  return { chat: { completions: { create: vi.fn(async () => ({ choices: [{ message: { content } }] })) } } } as any
}
const scan = async () => ([
  { filename: 'a.md', filePath: '/x/a.md', mtimeMs: 0, description: 'd', type: 'user' as const },
  { filename: 'b.md', filePath: '/x/b.md', mtimeMs: 0, description: 'd', type: 'project' as const },
])

test('解析 selected，校验真实文件名', async () => {
  const c = fakeClient('{"selected":["a.md","ghost.md"]}')
  const r = await findRelevantMemories(c, 'q', '/x', { maxResults: 5, model: 'm', signal: new AbortController().signal, scan })
  expect(r).toEqual(['a.md']) // ghost.md 被剔除
})
test('坏 JSON → []', async () => {
  const c = fakeClient('not json')
  expect(await findRelevantMemories(c, 'q', '/x', { maxResults: 5, model: 'm', signal: new AbortController().signal, scan })).toEqual([])
})
test('截断到 maxResults', async () => {
  const c = fakeClient('{"selected":["a.md","b.md"]}')
  const r = await findRelevantMemories(c, 'q', '/x', { maxResults: 1, model: 'm', signal: new AbortController().signal, scan })
  expect(r.length).toBe(1)
})
