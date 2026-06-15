import { describe, it, expect } from 'vitest'
import { lastAssistantText } from '../src/clipboard.js'

const sys = { role: 'system', content: 'you are a bot' }

describe('lastAssistantText', () => {
  it('只有 system 时返回 null', () => {
    expect(lastAssistantText([sys])).toBeNull()
  })

  it('单条 assistant 返回其文本', () => {
    expect(lastAssistantText([sys, { role: 'assistant', content: '你好' }])).toBe('你好')
  })

  it('多条 assistant 取最后一条', () => {
    const msgs = [
      sys,
      { role: 'assistant', content: '第一条' },
      { role: 'user', content: '继续' },
      { role: 'assistant', content: '第二条' },
    ]
    expect(lastAssistantText(msgs)).toBe('第二条')
  })

  it('最后是 user 时回溯到上一条 assistant', () => {
    const msgs = [
      sys,
      { role: 'assistant', content: '回复' },
      { role: 'user', content: '问题' },
    ]
    expect(lastAssistantText(msgs)).toBe('回复')
  })

  it('最后是 tool 时回溯到上一条 assistant', () => {
    const msgs = [
      sys,
      { role: 'assistant', content: '回复' },
      { role: 'tool', content: '工具结果', tool_call_id: 'x' },
    ]
    expect(lastAssistantText(msgs)).toBe('回复')
  })

  it('assistant content=null（带 tool_calls）跳过', () => {
    const msgs = [
      sys,
      { role: 'assistant', content: '有文本的回复' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'foo', arguments: '{}' } }] },
    ]
    expect(lastAssistantText(msgs)).toBe('有文本的回复')
  })

  it('纯空白 content 跳过', () => {
    const msgs = [
      sys,
      { role: 'assistant', content: '实质内容' },
      { role: 'assistant', content: '   \n\t  ' },
    ]
    expect(lastAssistantText(msgs)).toBe('实质内容')
  })

  it('content 非字符串跳过', () => {
    const msgs = [
      sys,
      { role: 'assistant', content: '正常文本' },
      { role: 'assistant', content: 123 as any },
    ]
    expect(lastAssistantText(msgs)).toBe('正常文本')
  })

  it('user/tool 消息被忽略，没有 assistant 返回 null', () => {
    const msgs = [
      sys,
      { role: 'user', content: '只有用户消息' },
      { role: 'tool', content: '工具结果', tool_call_id: 'x' },
    ]
    expect(lastAssistantText(msgs)).toBeNull()
  })
})
