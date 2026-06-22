import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { notebookEditTool } from '../src/tools/notebookEdit.js'
import { readTool } from '../src/tools/read.js'
import { parseNotebook } from '../src/notebook.js'
import { makeCtx } from './helpers.js'

const NB = { cells: [{ cell_type: 'code', source: 'old', id: 'c1', execution_count: 2, outputs: [{ output_type: 'stream', text: 'x' }] }], metadata: {}, nbformat: 4, nbformat_minor: 5 }

async function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dc-nbe-'))
  const f = path.join(dir, 'n.ipynb')
  writeFileSync(f, JSON.stringify(NB))
  const ctx = makeCtx(dir)
  await readTool.call({ file_path: f }, ctx) // read-before-edit
  return { f, ctx }
}

describe('NotebookEdit', () => {
  it('replace：改 source 且清空 outputs；写回合法 JSON', async () => {
    const { f, ctx } = await setup()
    const out = await notebookEditTool.call({ notebook_path: f, cell_id: 'c1', new_source: 'new code' }, ctx)
    expect(out).toContain('已编辑 notebook')
    const nb = parseNotebook(readFileSync(f, 'utf8'))!
    expect(nb.cells[0].source).toBe('new code')
    expect(nb.cells[0].outputs).toEqual([])
    expect(nb.cells[0].execution_count).toBeNull()
  })
  it('insert：需 cell_type，在 cell_id 之后', async () => {
    const { f, ctx } = await setup()
    await notebookEditTool.call({ notebook_path: f, cell_id: 'c1', new_source: '# md', cell_type: 'markdown', edit_mode: 'insert' }, ctx)
    const nb = parseNotebook(readFileSync(f, 'utf8'))!
    expect(nb.cells.length).toBe(2)
    expect(nb.cells[1].cell_type).toBe('markdown')
  })
  it('delete：移除 cell', async () => {
    const { f, ctx } = await setup()
    await notebookEditTool.call({ notebook_path: f, cell_id: 'c1', new_source: '', edit_mode: 'delete' }, ctx)
    const nb = parseNotebook(readFileSync(f, 'utf8'))!
    expect(nb.cells.length).toBe(0)
  })
  it('未 Read → read-before-edit 拒绝', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-nbe-'))
    const f = path.join(dir, 'n.ipynb')
    writeFileSync(f, JSON.stringify(NB))
    const out = await notebookEditTool.call({ notebook_path: f, cell_id: 'c1', new_source: 'x' }, makeCtx(dir))
    expect(out).toContain('必须先用 Read')
  })
  it('非法 JSON notebook → 报错', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-nbe-'))
    const f = path.join(dir, 'bad.ipynb')
    writeFileSync(f, 'not json')
    const ctx = makeCtx(dir)
    await readTool.call({ file_path: f }, ctx) // 回退纯文本读，设 fileState
    const out = await notebookEditTool.call({ notebook_path: f, cell_id: 'c1', new_source: 'x' }, ctx)
    expect(out).toContain('不是合法的 Jupyter notebook')
  })
})

describe('NotebookEdit 注册', () => {
  it('在 allTools 中', async () => {
    const { allTools } = await import('../src/tools/index.js')
    expect(allTools.some(t => t.name === 'NotebookEdit')).toBe(true)
  })
})
