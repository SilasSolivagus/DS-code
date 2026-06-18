import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeMemdirTools, assertInMemdir } from '../src/services/memory/memdirTools.js'

test('assertInMemdir 拦越界', () => {
  const md = '/home/u/.deepcode/projects/k/memory'
  expect(assertInMemdir(md, path.join(md, 'a.md'))).toBe(null)
  expect(assertInMemdir(md, path.join(md, 'sub/a.md'))).toBe(null)
  expect(assertInMemdir(md, '/home/u/.ssh/id_rsa')).not.toBe(null)
  expect(assertInMemdir(md, path.join(md, '../../../etc/passwd'))).not.toBe(null)
})

describe('makeMemdirTools 写工具', () => {
  let md: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-mt-')) })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }) })
  const ctx: any = { cwd: () => md, fileState: new Map(), signal: new AbortController().signal }

  test('MemWrite 落 memdir 内成功', async () => {
    const tools = makeMemdirTools(md)
    const w = tools.find(t => t.name === 'MemWrite')!
    const r = await w.call({ file_path: 'note.md', content: 'hi' }, ctx)
    expect(r).toContain('已写入')
    expect(fs.readFileSync(path.join(md, 'note.md'), 'utf8')).toBe('hi')
  })
  test('MemWrite 越界被拒、不写盘', async () => {
    const tools = makeMemdirTools(md)
    const w = tools.find(t => t.name === 'MemWrite')!
    const out = '/tmp/evil-' + path.basename(md) + '.txt'
    const r = await w.call({ file_path: out, content: 'x' }, ctx)
    expect(r).toMatch(/拒绝|越界|memory/)
    expect(fs.existsSync(out)).toBe(false)
  })
  test('含 Read', () => {
    expect(makeMemdirTools(md).some(t => t.name === 'Read')).toBe(true)
  })
})

describe('makeMemdirTools MemEdit', () => {
  let md: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-me-')) })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }) })
  const ctx: any = { cwd: () => md, fileState: new Map(), signal: new AbortController().signal }

  test('MemEdit 正常替换 memdir 内文件', async () => {
    fs.writeFileSync(path.join(md, 'n.md'), 'A B C')
    const e = makeMemdirTools(md).find(t => t.name === 'MemEdit')!
    const r = await e.call({ file_path: 'n.md', old_string: 'B', new_string: 'X' }, ctx)
    expect(r).toContain('已编辑')
    expect(fs.readFileSync(path.join(md, 'n.md'), 'utf8')).toBe('A X C')
  })
  test('MemEdit 越界被拒、不改盘', async () => {
    const other = path.join(os.tmpdir(), 'dc-me-evil.md'); fs.writeFileSync(other, 'Z')
    const e = makeMemdirTools(md).find(t => t.name === 'MemEdit')!
    const r = await e.call({ file_path: other, old_string: 'Z', new_string: 'Q' }, ctx)
    expect(r).toMatch(/拒绝|越界|memory/)
    expect(fs.readFileSync(other, 'utf8')).toBe('Z')
    fs.rmSync(other, { force: true })
  })
  test('MemEdit 文件不存在 → 错误串', async () => {
    const e = makeMemdirTools(md).find(t => t.name === 'MemEdit')!
    expect(await e.call({ file_path: 'nope.md', old_string: 'x', new_string: 'y' }, ctx)).toMatch(/不存在/)
  })
  test('MemEdit old_string 未匹配 → 错误串', async () => {
    fs.writeFileSync(path.join(md, 'n.md'), 'AAA')
    const e = makeMemdirTools(md).find(t => t.name === 'MemEdit')!
    expect(await e.call({ file_path: 'n.md', old_string: 'ZZZ', new_string: 'y' }, ctx)).toMatch(/未匹配/)
  })
})
