import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readTool } from '../src/tools/read.js'
import { makeCtx } from './helpers.js'

describe('Read', () => {
  it('带行号读取并记录 fileState', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-'))
    const f = path.join(dir, 'a.txt')
    writeFileSync(f, 'one\ntwo\nthree')
    const ctx = makeCtx(dir)
    const out = await readTool.call({ file_path: f }, ctx)
    expect(out).toContain('1\tone')
    expect(out).toContain('3\tthree')
    expect(ctx.fileState.has(f)).toBe(true)
  })

  it('offset/limit 分页并提示截断', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-'))
    const f = path.join(dir, 'b.txt')
    writeFileSync(f, Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n'))
    const out = await readTool.call({ file_path: f, offset: 2, limit: 2 }, makeCtx(dir))
    expect(out).toContain('2\tl2')
    expect(out).toContain('3\tl3')
    expect(out).not.toContain('4\tl4')
    expect(out).toContain('已截断')
  })

  it('文件不存在时返回模型可理解的错误', async () => {
    const out = await readTool.call({ file_path: '/no/such/file.txt' }, makeCtx('/tmp'))
    expect(out).toContain('文件不存在')
  })

  it('超长行截断', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-'))
    const f = path.join(dir, 'c.txt')
    writeFileSync(f, 'x'.repeat(5000))
    const out = await readTool.call({ file_path: f }, makeCtx(dir))
    expect(out.length).toBeLessThan(3000)
    expect(out).toContain('[行截断]')
  })

  it('offset 越界返回明确错误而非空串', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-'))
    const f = path.join(dir, 'd.txt')
    writeFileSync(f, 'only\ntwo')
    const out = await readTool.call({ file_path: f, offset: 99 }, makeCtx(dir))
    expect(out).toContain('超出文件总行数 2')
  })
})
