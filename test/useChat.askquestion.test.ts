import { describe, it, expect } from 'vitest'
import { createChatCore } from '../src/tui/useChat.js'

// 仅验证 pendingQuestion 桥的状态机契约：ChatState 暴露 pendingQuestion（初始 null），ChatCore 暴露 resolveQuestion。
describe('useChat AskUserQuestion 桥', () => {
  it('ChatState 暴露 pendingQuestion（初始 null），ChatCore 暴露 resolveQuestion', () => {
    const core = createChatCore({
      client: {} as any, yolo: false, cwd: '/tmp',
      sessionDir: '/tmp/dc-test-' + Math.random().toString(36).slice(2),
      onState: () => {},
    })
    expect(core.state.pendingQuestion).toBeNull()
    expect(typeof core.resolveQuestion).toBe('function')
  })
})
