// test/tui.cachesavings.test.tsx
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createChatCore } from '../src/tui/useChat.js'

describe('createChatCore.cacheSavings', () => {
  it('空会话（无 usage）时缓存省下金额为 0，且方法已暴露在 state 上', () => {
    const sessionDir = mkdtempSync(path.join(tmpdir(), 'dc-sav-'))
    const core = createChatCore({
      client: {} as any,
      yolo: true,
      cwd: tmpdir(),
      sessionDir,
      onState: () => {},
    })
    expect(typeof core.state.cacheSavings).toBe('function')
    expect(core.state.cacheSavings()).toBe(0)
    core.dispose()
  })
})
