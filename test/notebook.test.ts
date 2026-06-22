import { describe, it, expect } from 'vitest'
import { parseNotebook, serializeNotebook, generateCellId } from '../src/notebook.js'

const NB = {
  cells: [{ cell_type: 'code', source: 'print(1)', id: 'a1', outputs: [], execution_count: null }],
  metadata: { language_info: { name: 'python' } },
  nbformat: 4, nbformat_minor: 5,
}

describe('parseNotebook', () => {
  it('解析合法 notebook', () => {
    const nb = parseNotebook(JSON.stringify(NB))
    expect(nb?.cells.length).toBe(1)
    expect(nb?.cells[0].cell_type).toBe('code')
  })
  it('非法 JSON → null', () => {
    expect(parseNotebook('{not json')).toBeNull()
  })
  it('合法 JSON 但非 notebook（无 cells 数组）→ null', () => {
    expect(parseNotebook('{"foo":1}')).toBeNull()
    expect(parseNotebook('[]')).toBeNull()
  })
})

describe('serializeNotebook', () => {
  it('indent=1 且 round-trip 不丢内容', () => {
    const nb = parseNotebook(JSON.stringify(NB))!
    const out = serializeNotebook(nb)
    expect(out).toBe(JSON.stringify(NB, null, 1))
    expect(parseNotebook(out)).toEqual(nb)
  })
})

describe('generateCellId', () => {
  it('返回非空字符串且两次不同', () => {
    const a = generateCellId(); const b = generateCellId()
    expect(a).toBeTruthy(); expect(typeof a).toBe('string')
    expect(a).not.toBe(b)
  })
})

import { resolveCellIndex, applyCellEdit, formatNotebookForRead } from '../src/notebook.js'

function mk() {
  return {
    cells: [
      { cell_type: 'code', source: 'a', id: 'a1', execution_count: 3, outputs: [{ output_type: 'stream', text: 'x' }] },
      { cell_type: 'markdown', source: '# h', id: 'm1' },
    ],
    metadata: {}, nbformat: 4, nbformat_minor: 5,
  } as any
}

describe('resolveCellIndex', () => {
  it('按 id 匹配', () => { expect(resolveCellIndex(mk(), 'm1')).toBe(1) })
  it('按 cell-N 匹配', () => { expect(resolveCellIndex(mk(), 'cell-0')).toBe(0) })
  it('未命中 → -1', () => { expect(resolveCellIndex(mk(), 'nope')).toBe(-1); expect(resolveCellIndex(mk(), 'cell-9')).toBe(-1) })
})

describe('applyCellEdit', () => {
  it('replace code cell：改 source 且清空 outputs/execution_count', () => {
    const nb = mk()
    const r = applyCellEdit(nb, { cellId: 'a1', newSource: 'b', editMode: 'replace' })
    expect(r.ok).toBe(true)
    expect(nb.cells[0].source).toBe('b')
    expect(nb.cells[0].outputs).toEqual([])
    expect(nb.cells[0].execution_count).toBeNull()
  })
  it('insert：在 cell_id 之后插入，生成 id，需 cell_type', () => {
    const nb = mk()
    const r = applyCellEdit(nb, { cellId: 'a1', newSource: 'new', cellType: 'code', editMode: 'insert' })
    expect(r.ok).toBe(true)
    expect(nb.cells.length).toBe(3)
    expect(nb.cells[1].source).toBe('new')
    expect(nb.cells[1].id).toBeTruthy()
    expect(nb.cells[1].outputs).toEqual([])
  })
  it('insert 缺 cell_type → error', () => {
    const r = applyCellEdit(mk(), { cellId: 'a1', newSource: 'x', editMode: 'insert' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('cell_type')
  })
  it('delete：移除该 cell', () => {
    const nb = mk()
    const r = applyCellEdit(nb, { cellId: 'a1', newSource: '', editMode: 'delete' })
    expect(r.ok).toBe(true)
    expect(nb.cells.length).toBe(1)
    expect(nb.cells[0].id).toBe('m1')
  })
  it('cell 未命中 → error', () => {
    const r = applyCellEdit(mk(), { cellId: 'nope', newSource: 'x', editMode: 'replace' })
    expect(r.ok).toBe(false)
  })
})

describe('formatNotebookForRead', () => {
  it('code/markdown cell + cell id 回退 cell-N', () => {
    const nb = { cells: [
      { cell_type: 'code', source: 'print(1)' },                 // 无 id → cell-0
      { cell_type: 'markdown', source: ['# h', '\nbody'], id: 'm1' },
    ], metadata: {} } as any
    const out = formatNotebookForRead(nb)
    expect(out).toContain('<cell id="cell-0">')
    expect(out).toContain('print(1)')
    expect(out).toContain('<cell id="m1" type="markdown">')
    expect(out).toContain('# h\nbody')
  })
  it('code cell 的 outputs：stream/error 文本', () => {
    const nb = { cells: [{ cell_type: 'code', source: 'x', id: 'c', outputs: [
      { output_type: 'stream', text: 'hello' },
      { output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['line1', 'line2'] },
    ] }], metadata: {} } as any
    const out = formatNotebookForRead(nb)
    expect(out).toContain('hello')
    expect(out).toContain('ValueError: bad')
    expect(out).toContain('line1\nline2')
  })
  it('图像输出 → 文本占位', () => {
    const nb = { cells: [{ cell_type: 'code', source: 'x', id: 'c', outputs: [
      { output_type: 'display_data', data: { 'image/png': 'BASE64DATA' } },
    ] }], metadata: {} } as any
    expect(formatNotebookForRead(nb)).toContain('[图像输出已省略]')
  })
  it('大输出 → jq 提示截断', () => {
    const big = 'y'.repeat(10001)
    const nb = { cells: [{ cell_type: 'code', source: 'x', id: 'c', outputs: [
      { output_type: 'stream', text: big },
    ] }], metadata: {} } as any
    const out = formatNotebookForRead(nb)
    expect(out).not.toContain(big)
    expect(out).toContain("jq '.cells[0].outputs'")
  })
  it('非 python 语言的 code cell 标 language', () => {
    const nb = { cells: [{ cell_type: 'code', source: 'puts 1', id: 'c' }],
      metadata: { language_info: { name: 'ruby' } } } as any
    expect(formatNotebookForRead(nb)).toContain('<cell id="c" language="ruby">')
  })
})
