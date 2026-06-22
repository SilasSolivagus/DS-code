import { describe, it, expect } from 'vitest'
import type { PendingAsk } from '../src/tui/useChat.js'
import type { PermissionDecisionReason } from '../src/permissions.js'

// 烟囱测试：PendingAsk 类型须含可选 reason 字段（编译期 + 运行期形状）
describe('PendingAsk.reason', () => {
  it('可携带 decisionReason', () => {
    const reason: PermissionDecisionReason = { type: 'rule', rule: { source: 'user', behavior: 'deny', value: '~/.ssh/**' } }
    const ask: PendingAsk = { toolName: 'Bash', desc: 'cat ~/.ssh/id_rsa', dangerous: false, reason, resolve: () => {} }
    expect(ask.reason).toEqual(reason)
  })
})
