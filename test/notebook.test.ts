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
