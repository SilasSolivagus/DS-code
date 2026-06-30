// test/workflow.trigger.test.ts
import { describe, it, expect } from 'vitest'
import { detectUltracode, workflowUsageWarning } from '../src/workflow/trigger.js'

describe('ultracode 触发', () => {
  it('命中 ultracode 关键字', () => {
    expect(detectUltracode('please ultracode this audit')).toBe(true)
    expect(detectUltracode('normal request')).toBe(false)
    expect(detectUltracode('ultrathink about it')).toBe(false) // 不误触 ultrathink
  })
  it('消费门：skip=true → 不弹', () => {
    expect(workflowUsageWarning(true)).toBeNull()
    expect(workflowUsageWarning(false)).toMatch(/multi-agent workflow/)
  })
})
