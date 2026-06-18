import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanMemoryFiles, formatMemoryManifest } from '../src/memdir/memoryScan.js'

function write(dir: string, name: string, body: string) {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
  fs.writeFileSync(path.join(dir, name), body)
}

describe('scanMemoryFiles', () => {
  let md: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-scan-')) })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }) })

  test('解析 frontmatter、排除 MEMORY.md、按 mtime 降序', async () => {
    write(md, 'a.md', '---\nname: a\ndescription: desc A\ntype: user\n---\nbody')
    write(md, 'MEMORY.md', '- [a](a.md) — x')
    write(md, 'sub/b.md', '---\nname: b\ndescription: desc B\ntype: project\n---\nbody')
    // 让 b 比 a 新
    const now = Date.now()
    fs.utimesSync(path.join(md, 'a.md'), new Date(now - 10000), new Date(now - 10000))
    fs.utimesSync(path.join(md, 'sub/b.md'), new Date(now), new Date(now))
    const heads = await scanMemoryFiles(md)
    expect(heads.map(h => h.filename)).toEqual([path.join('sub', 'b.md'), 'a.md'])
    expect(heads[0]).toMatchObject({ description: 'desc B', type: 'project' })
    expect(heads.find(h => h.filename === 'MEMORY.md')).toBeUndefined()
  })

  test('坏 frontmatter → description null / type undefined，不抛', async () => {
    write(md, 'bad.md', 'no frontmatter here')
    const heads = await scanMemoryFiles(md)
    expect(heads[0]).toMatchObject({ description: null, type: undefined })
  })

  test('目录不存在 → 空数组', async () => {
    expect(await scanMemoryFiles(path.join(md, 'nope'))).toEqual([])
  })
})

test('formatMemoryManifest 列出每条', () => {
  const out = formatMemoryManifest([
    { filename: 'a.md', filePath: '/x/a.md', mtimeMs: 0, description: 'd', type: 'user' },
  ])
  expect(out).toContain('a.md')
  expect(out).toContain('d')
  expect(out).toContain('user')
})
