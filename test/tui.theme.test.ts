import { describe, it, expect } from 'vitest'
import { DEFAULT_THEME, SPINNER_FRAMES } from '../src/tui/theme.js'

describe('theme', () => {
  it('导出 DeepSeek 主题色与 spinner 帧', () => {
    expect(DEFAULT_THEME.accent).toBe('#6E8BFF')
    expect(DEFAULT_THEME.reasoning).toBeTypeOf('string')
    expect(SPINNER_FRAMES.length).toBeGreaterThan(4)
  })
})
