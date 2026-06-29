import { describe, it, expect } from 'vitest'
import {
  countNewlines, normalizePaste, newlineThreshold, shouldFold, makePlaceholder,
  makeTruncatePlaceholder, truncateBuffer, expandTextPlaceholders, stripTrailingPlaceholder,
} from '../src/tui/pasteFold.js'

describe('pasteFold', () => {
  it('countNewlines', () => { expect(countNewlines('a\nb\r\nc\rd')).toBe(3) })
  it('normalizePaste：\\r→\\n、tab→4空格、剥控制符留\\n', () => {
    expect(normalizePaste('a\tb\r\nc\x07')).toBe('a    b\nc')
  })
  it('newlineThreshold = min(rows-10,2)', () => {
    expect(newlineThreshold(24)).toBe(2); expect(newlineThreshold(11)).toBe(1)
  })
  it('shouldFold：>800字符 或 >阈值换行', () => {
    expect(shouldFold('x'.repeat(801), 24)).toBe(true)
    expect(shouldFold('x'.repeat(800), 24)).toBe(false)
    expect(shouldFold('\n\n\n', 24)).toBe(true)   // 3换行>2
    expect(shouldFold('\n\n', 24)).toBe(false)
  })
  it('makePlaceholder', () => {
    expect(makePlaceholder(1, 0)).toBe('[Pasted text #1]')
    expect(makePlaceholder(2, 5)).toBe('[Pasted text #2 +5 lines]')
  })
  it('truncateBuffer：≤10000 返回 null', () => { expect(truncateBuffer('x'.repeat(10000), 1)).toBeNull() })
  it('truncateBuffer：>10000 头500+占位符+尾500，中间存 entry', () => {
    const text = 'H'.repeat(500) + 'M\nM'.repeat(4000) + 'T'.repeat(500)
    const r = truncateBuffer(text, 7)!
    expect(r.newText.startsWith('H'.repeat(500))).toBe(true)
    expect(r.newText.endsWith('T'.repeat(500))).toBe(true)
    expect(r.newText).toContain('[...Truncated text #7 +')
    expect(r.entry.id).toBe(7)
    expect(r.entry.content.length).toBe(text.length - 1000)
  })
  it('expandTextPlaceholders：两类占位符→content', () => {
    const map = new Map([[1, { content: 'FULL1' }], [2, { content: 'MID2' }]])
    expect(expandTextPlaceholders('a [Pasted text #1] b [...Truncated text #2 +3 lines...] c', map))
      .toBe('a FULL1 b MID2 c')
  })
  it('expandTextPlaceholders：孤儿占位符（map无）原样留', () => {
    expect(expandTextPlaceholders('x [Pasted text #9] y', new Map())).toBe('x [Pasted text #9] y')
  })
  it('stripTrailingPlaceholder：行尾占位符整块删', () => {
    expect(stripTrailingPlaceholder('hi [Pasted text #1 +5 lines]')).toBe('hi ')
    expect(stripTrailingPlaceholder('hi there')).toBeNull()
  })
})
