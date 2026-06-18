import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRecaller, buildRecallReminder } from '../src/services/memory/recall.js'

test('buildRecallReminder 包 system-reminder', () => {
  const r = buildRecallReminder([{ filename: 'a.md', content: 'hello' }])
  expect(r).toContain('<system-reminder>')
  expect(r).toContain('a.md')
  expect(r).toContain('hello')
})

describe('createRecaller', () => {
  let md: string
  beforeEach(() => {
    md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-rec-'))
    fs.writeFileSync(path.join(md, 'a.md'), 'AAA')
  })
  afterEach(() => {
    fs.rmSync(md, { recursive: true, force: true })
  })

  test('prefetch→consume 注入选中文件，seen 去重', async () => {
    const find = vi.fn(async () => ['a.md'])
    const rec = createRecaller({ memdir: md, find, maxResults: 5 })
    rec.prefetch('q')
    await new Promise(r => setTimeout(r, 0))
    const out1 = rec.consume(new Set())
    expect(out1).toContain('AAA')
    rec.prefetch('q2')
    await new Promise(r => setTimeout(r, 0))
    const out2 = rec.consume(new Set()) // a.md 已 surface 过 → 不重复
    expect(out2).toBe(null)
  })

  test('alreadyRead 跳过模型本轮已读', async () => {
    const find = vi.fn(async () => ['a.md'])
    const rec = createRecaller({ memdir: md, find, maxResults: 5 })
    rec.prefetch('q')
    await new Promise(r => setTimeout(r, 0))
    expect(rec.consume(new Set([path.join(md, 'a.md')]))).toBe(null)
  })

  test('consume 字节上限：多大文件总量不超标', async () => {
    for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(md, n + '.md'), 'x'.repeat(10000))
    const find = vi.fn(async () => ['a.md', 'b.md', 'c.md'])
    const rec = createRecaller({ memdir: md, find, maxResults: 10 })
    rec.prefetch('q'); await new Promise(r => setTimeout(r, 0))
    const out = rec.consume(new Set())!
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(20000) // 修前会到 ~40KB
  })
})
