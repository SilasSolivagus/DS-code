import { describe, it, expect } from 'vitest'
import { resolveAttachments, expandTextAttachments } from '../src/tui/useChat.js'

describe('resolveAttachments / expandTextAttachments（文本部分）', () => {
  it('展开文本占位符为完整原文', async () => {
    const out = await resolveAttachments('看这段 [Pasted text #1] 谢谢', [{ id: 1, type: 'text', content: 'A\nB\nC' }])
    expect(out).toBe('看这段 A\nB\nC 谢谢')
  })
  it('无附件原样返回', async () => {
    expect(await resolveAttachments('hello', undefined)).toBe('hello')
  })
  it('expandTextAttachments 同步展开（steer 路径用）', () => {
    expect(expandTextAttachments('a [Pasted text #1] b', [{ id: 1, type: 'text', content: 'X\nY' }])).toBe('a X\nY b')
    expect(expandTextAttachments('a', undefined)).toBe('a')
  })
})
