import { describe, it, expect } from 'vitest'
import { parseLoopCommand } from '../src/commands.js'

describe('parseLoopCommand', () => {
  it('有区间 → fixed 模式 + cron', () => {
    expect(parseLoopCommand('/loop 5m 跑测试')).toEqual({ mode: 'fixed', cron: '*/5 * * * *', prompt: '跑测试' })
    expect(parseLoopCommand('/loop 1h 看 PR')).toEqual({ mode: 'fixed', cron: '0 * * * *', prompt: '看 PR' })
  })
  it('无区间有 prompt → dynamic 自起步', () => {
    expect(parseLoopCommand('/loop 持续盯 CI')).toEqual({ mode: 'dynamic', prompt: '持续盯 CI' })
  })
  it('无 prompt → autonomous', () => {
    expect(parseLoopCommand('/loop')).toEqual({ mode: 'autonomous' })
  })
})
