// test/tools.write.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeTool } from '../src/tools/write.js'
import { readTool } from '../src/tools/read.js'
import { makeCtx } from './helpers.js'

describe('Write', () => {
  it('新建文件无需先 Read，且自动创建父目录', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-'))
    const f = path.join(dir, 'sub/dir/new.txt')
    const out = await writeTool.call({ file_path: f, content: 'hello' }, makeCtx(dir))
    expect(out).toContain('已写入')
    expect(readFileSync(f, 'utf8')).toBe('hello')
  })

  it('覆盖已存在文件必须先 Read', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-'))
    const f = path.join(dir, 'a.txt')
    writeFileSync(f, 'old')
    const out = await writeTool.call({ file_path: f, content: 'new' }, makeCtx(dir))
    expect(out).toContain('必须先用 Read')
    expect(readFileSync(f, 'utf8')).toBe('old') // 未被覆盖
  })

  it('Read 后可覆盖，且 fileState 更新（可接着 Edit）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-'))
    const f = path.join(dir, 'b.txt')
    writeFileSync(f, 'old')
    const ctx = makeCtx(dir)
    await readTool.call({ file_path: f }, ctx)
    const out = await writeTool.call({ file_path: f, content: 'brand new' }, ctx)
    expect(out).toContain('已写入')
    expect(readFileSync(f, 'utf8')).toBe('brand new')
    // 写入后 fileState 是新 mtime：继续 Edit 不应被拦
    const { editTool } = await import('../src/tools/edit.js')
    const out2 = await editTool.call({ file_path: f, old_string: 'brand', new_string: 'very' }, ctx)
    expect(out2).toContain('已编辑')
  })
})
