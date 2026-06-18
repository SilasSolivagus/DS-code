import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { truncateEntrypoint, loadMemoryPrompt, MAX_ENTRYPOINT_LINES } from '../src/memdir/memdir.js'

test('truncateEntrypoint 行数上限', () => {
  const many = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
  const out = truncateEntrypoint(many)
  expect(out.split('\n').length).toBeLessThanOrEqual(MAX_ENTRYPOINT_LINES + 1)
  expect(out).toContain('截断')
})

test('truncateEntrypoint 字节上限（含省略提示也不超）', () => {
  const big = 'x'.repeat(30000)
  const out = truncateEntrypoint(big)
  expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(25600)
  expect(out).toContain('截断')
})

test('truncateEntrypoint 多字节不裂字符且不超字节上限', () => {
  const big = '汉'.repeat(20000) // 每字 3 字节 = 60000 字节
  const out = truncateEntrypoint(big)
  expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(25600)
  expect(out.includes('�')).toBe(false) // 无替换字符
})

describe('loadMemoryPrompt', () => {
  let md: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-load-')) })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }) })
  test('有 MEMORY.md → 注入内容', () => {
    fs.writeFileSync(path.join(md, 'MEMORY.md'), '- [a](a.md) — hook')
    const out = loadMemoryPrompt(md)
    expect(out).toContain('## 记忆索引')
    expect(out).toContain('a.md')
  })
  test('无 MEMORY.md → 空提示', () => {
    const out = loadMemoryPrompt(md)
    expect(out).toContain('## 记忆索引')
    expect(out).toContain('暂无')
  })
})
