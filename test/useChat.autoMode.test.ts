import { describe, it, expect } from 'vitest'
import { nextPermMode } from '../src/tui/useChat.js'

describe('nextPermMode 四态循环', () => {
  it('default→auto→acceptEdits→plan→default', () => {
    expect(nextPermMode('default', false)).toBe('auto')
    expect(nextPermMode('auto', false)).toBe('acceptEdits')
    expect(nextPermMode('acceptEdits', false)).toBe('plan')
    expect(nextPermMode('plan', false)).toBe('default')
  })
  it('disableAutoMode=true 时跳过 auto', () => {
    expect(nextPermMode('default', true)).toBe('acceptEdits')
  })
})
