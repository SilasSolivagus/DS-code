import { describe, it, expect } from 'vitest'
import { Assembler } from '../src/api.js'

describe('Assembler', () => {
  it('拼装文本增量并逐段返回', () => {
    const a = new Assembler()
    expect(a.push({ choices: [{ delta: { content: '你' } }] })).toEqual({ text: '你', reasoning: '' })
    expect(a.push({ choices: [{ delta: { content: '好' } }] })).toEqual({ text: '好', reasoning: '' })
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
    expect(a.push({ choices: [] })).toEqual({ text: '', reasoning: '' })
    expect(a.push({})).toEqual({ text: '', reasoning: '' })
  })

  it('finish_reason 与 usage 在同一 chunk（DeepSeek 末包结构）', () => {
    const a = new Assembler()
    a.push({ choices: [{ delta: { content: 'hi' } }] })
    a.push({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2, prompt_cache_hit_tokens: 3 } })
    const r = a.finish()
    expect(r.finishReason).toBe('stop')
    expect(r.usage.prompt_cache_hit_tokens).toBe(3)
    expect(r.content).toBe('hi')
  })

  it('content 与 tool_calls 混在同一 delta', () => {
    const a = new Assembler()
    expect(a.push({ choices: [{ delta: { content: '我来读', tool_calls: [{ index: 0, id: 'c9', function: { name: 'Read', arguments: '{}' } }] } }] })).toEqual({ text: '我来读', reasoning: '' })
    const r = a.finish()
    expect(r.content).toBe('我来读')
    expect(r.toolCalls).toEqual([{ id: 'c9', name: 'Read', args: '{}' }])
  })

  it('reasoning_content 流式返回供显示，但不进 content', () => {
    const a = new Assembler()
    expect(a.push({ choices: [{ delta: { reasoning_content: '思考中…' } }] })).toEqual({ text: '', reasoning: '思考中…' })
    expect(a.push({ choices: [{ delta: { content: '答案' } }] })).toEqual({ text: '答案', reasoning: '' })
    expect(a.finish().content).toBe('答案')
  })
})
