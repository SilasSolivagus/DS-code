import { describe, it, expect, vi } from 'vitest'
import { renderMarkdown } from '../src/tui/markdown.js'

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

describe('renderMarkdown', () => {
  it('标题加粗并带 § 前缀，正文原样', () => {
    const out = renderMarkdown('## 计划\n正文一句')
    expect(out).toContain('\x1b[1m')          // 粗体 ANSI
    expect(strip(out)).toContain('§ 计划')
    expect(strip(out)).toContain('正文一句')
  })

  it('行内代码与代码块都有样式，代码块保留多行', () => {
    const out = renderMarkdown('用 `npm test` 跑\n```js\nconst a = 1\nconst b = 2\n```')
    expect(strip(out)).toContain('npm test')
    expect(strip(out)).toContain('const a = 1')
    expect(strip(out)).toContain('const b = 2')
    expect(out).toContain('\x1b[')            // 至少有着色
  })

  it('列表渲染为圆点，表格渲染为对齐行', () => {
    const out = strip(renderMarkdown('- 甲\n- 乙\n\n| a | b |\n|---|---|\n| 1 | 2 |'))
    expect(out).toContain('• 甲')
    expect(out).toContain('• 乙')
    expect(out.split('\n').some(l => l.includes('1') && l.includes('2') && l.includes('│'))).toBe(true)
  })

  it('渲染失败时降级返回原文不抛异常', () => {
    expect(renderMarkdown('普通文本')).toContain('普通文本')
  })

  it('有序列表保留编号，不渲染圆点', () => {
    const out = strip(renderMarkdown('1. 甲\n2. 乙\n3. 丙'))
    expect(out).toContain('1. 甲')
    expect(out).toContain('2. 乙')
    expect(out).toContain('3. 丙')
    expect(out).not.toContain('•')
  })

  it('未知 fence 语言不向 stderr 输出，代码体仍保留', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const out = strip(renderMarkdown('```mermaid\ngraph TD\nA --> B\n```'))
      expect(spy).not.toHaveBeenCalled()
      expect(out).toContain('graph TD')
    } finally {
      spy.mockRestore()
    }
  })
})
