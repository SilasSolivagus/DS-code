import { describe, it, expect } from 'vitest'
import { parseTokenBudget, shouldContinueForBudget } from '../src/tokenBudget.js'

describe('parseTokenBudget', () => {
  it('开头 shorthand：+500k / +2m / +1.5b（大小写不敏感）', () => {
    expect(parseTokenBudget('+500k')).toBe(500_000)
    expect(parseTokenBudget('+2M fix the bug')).toBe(2_000_000)
    expect(parseTokenBudget('+1.5b please')).toBe(1_500_000_000)
  })
  it('结尾 shorthand：... +500k 带可选标点', () => {
    expect(parseTokenBudget('refactor everything +500k')).toBe(500_000)
    expect(parseTokenBudget('do it all +2m.')).toBe(2_000_000)
  })
  it('verbose：use/spend N tokens（必须带后缀）', () => {
    expect(parseTokenBudget('use 500k tokens on this')).toBe(500_000)
    expect(parseTokenBudget('spend 2M tokens')).toBe(2_000_000)
    expect(parseTokenBudget('use 1k token')).toBe(1_000) // 单复数都收
  })
  it('清除：+0k → 0', () => {
    expect(parseTokenBudget('+0k')).toBe(0)
  })
  it('无后缀/自然语言不误匹配 → null', () => {
    expect(parseTokenBudget('+1000000')).toBeNull()        // 无后缀
    expect(parseTokenBudget('fix the +5 bug')).toBeNull()  // +5 无后缀
    expect(parseTokenBudget('hello world')).toBeNull()
    expect(parseTokenBudget('use more tokens')).toBeNull() // 无数字
    expect(parseTokenBudget('the cost is 500k yuan')).toBeNull() // 非预算句式
  })
})

describe('shouldContinueForBudget', () => {
  const base = { budget: 500_000, outputSoFar: 100_000, continuations: 0, lastDeltas: [] as number[] }
  it('未达 90% → 续跑', () => {
    expect(shouldContinueForBudget({ ...base, outputSoFar: 100_000 })).toBe(true)
  })
  it('达 90% → 停', () => {
    expect(shouldContinueForBudget({ ...base, outputSoFar: 450_000 })).toBe(false)
    expect(shouldContinueForBudget({ ...base, outputSoFar: 460_000 })).toBe(false)
  })
  it('budget null / 0 → 停（无预算）', () => {
    expect(shouldContinueForBudget({ ...base, budget: null as any })).toBe(false)
    expect(shouldContinueForBudget({ ...base, budget: 0 })).toBe(false)
  })
  it('收益递减熔断：续跑≥3 且最近两次 delta<500 → 停', () => {
    expect(shouldContinueForBudget({ ...base, continuations: 3, lastDeltas: [10_000, 400, 300] })).toBe(false)
  })
  it('续跑≥3 但最近 delta 仍大 → 继续', () => {
    expect(shouldContinueForBudget({ ...base, continuations: 3, lastDeltas: [400, 5_000, 6_000] })).toBe(true)
  })
})
