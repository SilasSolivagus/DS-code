import { describe, it, expect } from 'vitest'
import { formatToolArg } from '../src/tui/toolArg.js'

describe('toolArg', () => {
  it('剥除 C1 控制字符（含 \\x9b CSI）', () => {
    const out = formatToolArg('Bash', JSON.stringify({ command: 'ls\x9b2K x' }))
    expect(out).not.toContain('\x9b')
  })
})
