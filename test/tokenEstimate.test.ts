import { describe, it, expect } from 'vitest'
import { estimateTextTokens, estimateMessagesTokens } from '../src/tokenEstimate.js'

describe('estimateTextTokens', () => {
  it('空/undefined/null → 0', () => {
    expect(estimateTextTokens('')).toBe(0)
    expect(estimateTextTokens(undefined)).toBe(0)
    expect(estimateTextTokens(null)).toBe(0)
  })
  it('纯英文按 ×0.3/字（ceil）', () => {
    // 10 个 ASCII 字符 → ceil(10*0.3)=3
    expect(estimateTextTokens('abcdefghij')).toBe(3)
  })
  it('纯中文按 ×0.6/字（ceil）', () => {
    // 5 个中文 → ceil(5*0.6)=3
    expect(estimateTextTokens('你好世界啊')).toBe(3)
  })
  it('中英混排分别加权', () => {
    // 「你好abc」= 2*0.6 + 3*0.3 = 1.2+0.9=2.1 → ceil=3
    expect(estimateTextTokens('你好abc')).toBe(3)
  })
  it('数字标点空白按 ×0.3（非 CJK）', () => {
    // 「a 1!」= 4 字符 *0.3 = 1.2 → ceil=2
    expect(estimateTextTokens('a 1!')).toBe(2)
  })
})

describe('estimateMessagesTokens', () => {
  it('空数组 → 0', () => {
    expect(estimateMessagesTokens([])).toBe(0)
  })
  it('累加各条 content（string）', () => {
    const msgs = [
      { role: 'system', content: 'abcdefghij' }, // 3
      { role: 'user', content: '你好世界啊' },     // 3
    ]
    expect(estimateMessagesTokens(msgs)).toBe(6)
  })
  it('content 为 null 不抛、计 0；assistant tool_calls 估 name+arguments', () => {
    const msgs = [
      { role: 'assistant', content: null, tool_calls: [
        { function: { name: 'Read', arguments: '{"file":"a"}' } }, // 'Read{"file":"a"}'=16字符*0.3=4.8→单条但整体 ceil
      ] },
    ]
    // 'Read' + '{"file":"a"}' = 4+12 = 16 ASCII → 16*0.3=4.8 → ceil=5
    expect(estimateMessagesTokens(msgs)).toBe(5)
  })
  it('tool 消息 content 计入', () => {
    const msgs = [{ role: 'tool', tool_call_id: 'x', content: 'abcdefghij' }] // 3
    expect(estimateMessagesTokens(msgs)).toBe(3)
  })
})
