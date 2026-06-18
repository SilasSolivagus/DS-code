import { describe, it, expect } from 'vitest'
import stringWidth from 'string-width'
import { renderMarkdown } from '../src/tui/markdown.js'

describe('renderMarkdown 表格 CJK 列宽', () => {
  it('中文单元格各行到分隔符的显示宽度一致（列对齐）', () => {
    const md = '| 名称 | 说明 |\n| --- | --- |\n| 模型切换 | 改档位 |\n| a | b |'
    const out = renderMarkdown(md)
    // 去 ANSI 转义后按行取第一列内容（到第一个 │ 之前），各行显示宽度应相等
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
    const lines = stripAnsi(out).split('\n').filter(l => l.includes('│'))
    const firstColWidths = lines.map(l => stringWidth(l.slice(0, l.indexOf('│'))))
    expect(new Set(firstColWidths).size).toBe(1) // 所有行第一列等宽
  })
})
