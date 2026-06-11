// test/tools.edit.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { editTool } from '../src/tools/edit.js'
import { readTool } from '../src/tools/read.js'
import { makeCtx } from './helpers.js'

async function setup(content: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dc-'))
  const f = path.join(dir, 'a.ts')
  writeFileSync(f, content)
  const ctx = makeCtx(dir)
  await readTool.call({ file_path: f }, ctx) // 正常流程：先 Read
  return { dir, f, ctx }
}

describe('Edit', () => {
  it('Read 过的文件可以替换，且 fileState 更新（可连续编辑）', async () => {
    const { f, ctx } = await setup('const a = 1\nconst b = 2\n')
    const out1 = await editTool.call({ file_path: f, old_string: 'const a = 1', new_string: 'const a = 10' }, ctx)
    expect(out1).toContain('已编辑')
    expect(readFileSync(f, 'utf8')).toContain('const a = 10')
    // 编辑后无需重新 Read 即可再编辑
    const out2 = await editTool.call({ file_path: f, old_string: 'const b = 2', new_string: 'const b = 20' }, ctx)
    expect(out2).toContain('已编辑')
  })

  it('未 Read 直接编辑被拒绝', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-'))
    const f = path.join(dir, 'b.ts')
    writeFileSync(f, 'x')
    const out = await editTool.call({ file_path: f, old_string: 'x', new_string: 'y' }, makeCtx(dir))
    expect(out).toContain('必须先用 Read')
  })

  it('Read 之后被外部修改 → 要求重新 Read', async () => {
    const { f, ctx } = await setup('hello')
    writeFileSync(f, 'hello!') // 外部修改
    utimesSync(f, new Date(), new Date(Date.now() + 5000)) // 确保 mtime 变化
    const out = await editTool.call({ file_path: f, old_string: 'hello', new_string: 'hi' }, ctx)
    expect(out).toContain('被外部修改')
  })

  it('old_string 不存在 → 可自我修正的错误', async () => {
    const { f, ctx } = await setup('abc')
    const out = await editTool.call({ file_path: f, old_string: 'xyz', new_string: 'q' }, ctx)
    expect(out).toContain('没有找到')
  })

  it('old_string 不唯一 → 报出现次数', async () => {
    const { f, ctx } = await setup('dup\ndup\n')
    const out = await editTool.call({ file_path: f, old_string: 'dup', new_string: 'one' }, ctx)
    expect(out).toContain('出现了 2 次')
  })

  it('replace_all 全部替换', async () => {
    const { f, ctx } = await setup('dup\ndup\n')
    const out = await editTool.call({ file_path: f, old_string: 'dup', new_string: 'one', replace_all: true }, ctx)
    expect(out).toContain('2 处')
    expect(readFileSync(f, 'utf8')).toBe('one\none\n')
  })

  it('new_string 含 $& 等不被正则替换特殊解释', async () => {
    const { f, ctx } = await setup('price = X')
    await editTool.call({ file_path: f, old_string: 'X', new_string: '$&100$$' }, ctx)
    expect(readFileSync(f, 'utf8')).toBe('price = $&100$$')
  })

  it('old_string 与 new_string 相同 → 拒绝', async () => {
    const { f, ctx } = await setup('same')
    const out = await editTool.call({ file_path: f, old_string: 'same', new_string: 'same' }, ctx)
    expect(out).toContain('相同')
  })

  it('空 old_string 被 schema 拒绝（防止 split 腐化文件）', () => {
    const parsed = editTool.inputSchema.safeParse({ file_path: '/x', old_string: '', new_string: 'y', replace_all: true })
    expect(parsed.success).toBe(false)
  })

  it('多行 old_string 替换（最高频真实场景）', async () => {
    const { f, ctx } = await setup('function foo() {\n  return 1\n}\n')
    const out = await editTool.call(
      { file_path: f, old_string: 'function foo() {\n  return 1\n}', new_string: 'function foo() {\n  return 2\n}' },
      ctx,
    )
    expect(out).toContain('已编辑')
    expect(readFileSync(f, 'utf8')).toContain('return 2')
  })
})
