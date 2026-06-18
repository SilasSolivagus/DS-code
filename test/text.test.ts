import { describe, it, expect } from 'vitest'
import { capToolResult } from '../src/text.js'

describe('capToolResult', () => {
  it('欠阈原样返回', () => {
    expect(capToolResult('hello', 100)).toBe('hello')
  })
  it('等于阈值原样返回', () => {
    const s = 'x'.repeat(100)
    expect(capToolResult(s, 100)).toBe(s)
  })
  it('超阈截断：保留头尾 + 标注被截字符数，且总长远小于原文', () => {
    const s = 'a'.repeat(700) + 'b'.repeat(300) // 1000 字符
    const out = capToolResult(s, 100)
    expect(out.length).toBeLessThan(s.length)
    expect(out).toContain('已截断')
    expect(out.startsWith('a')).toBe(true) // 保留了头
    expect(out.endsWith('b')).toBe(true)   // 保留了尾
  })
})
