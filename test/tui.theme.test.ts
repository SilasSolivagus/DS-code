import { describe, it, expect } from 'vitest'
import { T, SPINNER_FRAMES } from '../src/tui/theme.js'

describe('theme', () => {
  it('导出 DeepSeek 主题色与 spinner 帧', () => {
    expect(T.accent).toBe('#4D6BFE')
    expect(T.reasoning).toBeTypeOf('string')
    expect(SPINNER_FRAMES.length).toBeGreaterThan(4)
  })
})
