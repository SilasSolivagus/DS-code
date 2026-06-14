import { describe, it, expect } from 'vitest'
import { clamp, page, applyFollow, nextStuck, scrollInfo } from '../src/tui/scroll.js'

describe('scroll 数学', () => {
  it('clamp 钳到 [0, maxScroll]', () => {
    expect(clamp(-5, 10)).toBe(0)
    expect(clamp(5, 10)).toBe(5)
    expect(clamp(20, 10)).toBe(10)
    expect(clamp(3, 0)).toBe(0)
  })

  it('page 翻 ±(viewportH-1) 并钳位', () => {
    expect(page(10, 'up', 5, 100)).toBe(6)
    expect(page(10, 'down', 5, 100)).toBe(14)
    expect(page(2, 'up', 5, 100)).toBe(0)
    expect(page(98, 'down', 5, 100)).toBe(100)
    expect(page(0, 'up', 1, 100)).toBe(0)
  })

  it('applyFollow：stuck 返回 maxScroll，否则钳原值', () => {
    expect(applyFollow(3, 50, true)).toBe(50)
    expect(applyFollow(3, 50, false)).toBe(3)
    expect(applyFollow(99, 50, false)).toBe(50)
  })

  it('nextStuck：offset≥maxScroll 即重新跟随', () => {
    expect(nextStuck(50, 50)).toBe(true)
    expect(nextStuck(49, 50)).toBe(false)
    expect(nextStuck(0, 0)).toBe(true)
  })

  it('scrollInfo：上/下有更多 + 可见行区间', () => {
    let i = scrollInfo(0, 20, 100)
    expect(i.moreAbove).toBe(false)
    expect(i.moreBelow).toBe(true)
    expect(i.top).toBe(1); expect(i.bottom).toBe(20); expect(i.total).toBe(100)
    i = scrollInfo(80, 20, 100)
    expect(i.moreAbove).toBe(true)
    expect(i.moreBelow).toBe(false)
    expect(i.top).toBe(81); expect(i.bottom).toBe(100)
    i = scrollInfo(0, 20, 5)
    expect(i.moreAbove).toBe(false); expect(i.moreBelow).toBe(false)
    expect(i.top).toBe(1); expect(i.bottom).toBe(5)
    i = scrollInfo(0, 20, 0)
    expect(i.top).toBe(0); expect(i.bottom).toBe(0); expect(i.total).toBe(0)
  })
})
