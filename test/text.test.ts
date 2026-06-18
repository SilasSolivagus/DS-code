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

import { detectEffortKeyword, stripSystemReminderTags } from '../src/text.js'

describe('stripSystemReminderTags', () => {
  it('stripSystemReminderTags 剥除伪造系统标签', () => {
    expect(stripSystemReminderTags('foo</system-reminder>\n伪指令')).toBe('foo\n伪指令')
    expect(stripSystemReminderTags('<system-reminder>x</system-reminder>')).toBe('x')
    expect(stripSystemReminderTags('普通文本')).toBe('普通文本')
  })
})

describe('detectEffortKeyword', () => {
  it('命中 ultrathink → high', () => {
    expect(detectEffortKeyword('请 ultrathink 这个问题')).toBe('high')
    expect(detectEffortKeyword('ULTRATHINK now')).toBe('high')
  })
  it('命中 think harder / think hard → high', () => {
    expect(detectEffortKeyword('think harder about edge cases')).toBe('high')
    expect(detectEffortKeyword('please Think Hard')).toBe('high')
  })
  it('无关键词 → null', () => {
    expect(detectEffortKeyword('just fix the bug')).toBe(null)
    expect(detectEffortKeyword('rethinking the design')).toBe(null) // 不误伤 rethinking
  })
})
