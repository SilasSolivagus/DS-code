import { describe, it, expect } from 'vitest'
import { PLAN_MODE_GUIDANCE } from '../src/prompt.js'

describe('PLAN_MODE_GUIDANCE', () => {
  it('包含 plan 模式核心指引', () => {
    expect(PLAN_MODE_GUIDANCE).toContain('plan')
    expect(PLAN_MODE_GUIDANCE).toContain('ExitPlanMode')
    expect(PLAN_MODE_GUIDANCE.length).toBeGreaterThan(40)
  })
})
