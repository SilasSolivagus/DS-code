import { describe, it, expect } from 'vitest'
import { buildRecentContext } from '../src/loop.js'

describe('buildRecentContext', () => {
  it('取最近 N 条 tool message，截断', () => {
    const msgs = [
      { role: 'user', content: 'x' },
      { role: 'tool', content: 'AAA' },
      { role: 'assistant', content: 'y' },
      { role: 'tool', content: 'BBB' },
    ]
    const ctx = buildRecentContext(msgs as any, 2, 4000)
    expect(ctx).toContain('AAA')
    expect(ctx).toContain('BBB')
  })

  it('无 tool message → 空串', () => {
    expect(buildRecentContext([{ role: 'user', content: 'x' }] as any, 2, 4000)).toBe('')
  })

  it('只取最近 N 条（超出时截取尾部）', () => {
    const msgs = [
      { role: 'tool', content: 'OLD' },
      { role: 'tool', content: 'A' },
      { role: 'tool', content: 'B' },
    ]
    const ctx = buildRecentContext(msgs as any, 2, 4000)
    expect(ctx).not.toContain('OLD')
    expect(ctx).toContain('A')
    expect(ctx).toContain('B')
  })

  it('截断到 maxChars', () => {
    const msgs = [{ role: 'tool', content: 'X'.repeat(100) }]
    const ctx = buildRecentContext(msgs as any, 2, 10)
    expect(ctx.length).toBeLessThanOrEqual(10)
  })
})
