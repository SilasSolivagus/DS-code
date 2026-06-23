// test/promptSections.test.ts
import { describe, it, expect } from 'vitest'
import { SYSTEM_SECTION } from '../src/prompt.js'

describe('SYSTEM_SECTION', () => {
  it('以 # 系统 标题开头', () => {
    expect(SYSTEM_SECTION.startsWith('# 系统')).toBe(true)
  })
  it('含 prompt injection 上报规则', () => {
    expect(SYSTEM_SECTION).toContain('prompt injection')
  })
  it('含 <system-reminder> 不权威规则', () => {
    expect(SYSTEM_SECTION).toContain('<system-reminder>')
  })
  it('含「拒绝后不重试同一调用」规则', () => {
    expect(SYSTEM_SECTION).toContain('不要重试完全相同的调用')
  })
})
