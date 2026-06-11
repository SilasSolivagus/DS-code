import { describe, it, expect } from 'vitest'
import { Assembler } from '../src/api.js'

describe('Assembler', () => {
  it('拼装文本增量并逐段返回', () => {
    const a = new Assembler()
    expect(a.push({ choices: [{ delta: { content: '你' } }] })).toBe('你')
    expect(a.push({ choices: [{ delta: { content: '好' } }] })).toBe('好')
    expect(a.finish().content).toBe('你好')
  })

  it('拼装跨分片的并行 tool_calls', () => {
    const a = new Assembler()
    a.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read', arguments: '' } }] } }] })
    a.push({ choices: [{ delta: { tool_calls: [
      { index: 0, function: { arguments: '{"file_' } },
      { index: 1, id: 'c2', function: { name: 'Glob', arguments: '{"pattern"' } },
    ] } }] })
    a.push({ choices: [{ delta: { tool_calls: [
      { index: 0, function: { arguments: 'path":"a.ts"}' } },
      { index: 1, function: { arguments: ':"**/*.ts"}' } },
    ] } }] })
    a.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
    const r = a.finish()
    expect(r.toolCalls).toEqual([
      { id: 'c1', name: 'Read', args: '{"file_path":"a.ts"}' },
      { id: 'c2', name: 'Glob', args: '{"pattern":"**/*.ts"}' },
    ])
    expect(r.finishReason).toBe('tool_calls')
  })

  it('记录 usage（含缓存命中字段）', () => {
    const a = new Assembler()
    a.push({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 80 } })
    expect(a.finish().usage).toEqual({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 80 })
  })

  it('空 choices 分片不崩溃', () => {
    const a = new Assembler()
    expect(a.push({ choices: [] })).toBe('')
    expect(a.push({})).toBe('')
  })
})
