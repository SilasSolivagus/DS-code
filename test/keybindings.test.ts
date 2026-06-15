import { describe, it, expect } from 'vitest'
import { formatKeybindings } from '../src/keybindings.js'

describe('formatKeybindings', () => {
  const text = formatKeybindings()

  it('包含分组标题', () => {
    expect(text).toContain('输入框')
    expect(text).toContain('滚动')
    expect(text).toContain('触发')
    expect(text).toContain('选中')
  })

  it('包含每个关键键位', () => {
    for (const key of ['Esc', 'Enter', 'Tab', 'PageUp', 'PageDown', 'Ctrl+G', 'Ctrl+C', '/', '@', '!', 'Shift', '滚轮']) {
      expect(text).toContain(key)
    }
  })

  it('每条为「按键 — 说明」格式', () => {
    expect(text).toContain('—')
  })
})
