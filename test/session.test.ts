import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as nodeFs from 'node:fs'
import { newSession, openSession, listSessions, loadSession, type SessionMeta } from '../src/session.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'dc-sess-'))
})

const meta = (cwd: string): SessionMeta => ({ cwd, model: 'deepseek-v4-flash', thinking: false, permMode: 'default' })

describe('session', () => {
  it('newSession 写 meta 行，append 各类记录，loadSession 还原', () => {
    const h = newSession(meta('/proj'), dir)
    h.appendMessage({ role: 'system', content: 's' })
    h.appendMessage({ role: 'user', content: '你好' })
    h.appendMessage({ role: 'assistant', content: '在' })
    h.appendUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 4 }, 'deepseek-v4-flash')
    h.appendFileState([['/proj/a.ts', 123]])

    const loaded = loadSession(h.file)
    expect(loaded.meta.cwd).toBe('/proj')
    expect(loaded.meta.model).toBe('deepseek-v4-flash')
    expect(loaded.messages.map(m => m.role)).toEqual(['system', 'user', 'assistant'])
    expect(loaded.usages).toEqual([{ usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 4 }, model: 'deepseek-v4-flash' }])
    expect(loaded.fileState).toEqual([['/proj/a.ts', 123]])
  })

  it('loadSession 取最后一条 fs 记录作为最新快照', () => {
    const h = newSession(meta('/p'), dir)
    h.appendFileState([['/p/a', 1]])
    h.appendFileState([['/p/a', 1], ['/p/b', 2]])
    expect(loadSession(h.file).fileState).toEqual([['/p/a', 1], ['/p/b', 2]])
  })

  it('openSession 续写已存在文件，不重写 meta', () => {
    const h1 = newSession(meta('/p'), dir)
    h1.appendMessage({ role: 'user', content: '一' })
    const h2 = openSession(h1.file)
    h2.appendMessage({ role: 'user', content: '二' })
    expect(loadSession(h1.file).messages.map(m => m.content)).toEqual(['一', '二'])
  })

  it('listSessions 只返回匹配 cwd 的会话，带首条 user 预览，按新到旧', () => {
    const a = newSession(meta('/projA'), dir)
    a.appendMessage({ role: 'system', content: 's' })
    a.appendMessage({ role: 'user', content: '任务A' })
    const b = newSession(meta('/projB'), dir)
    b.appendMessage({ role: 'user', content: '任务B' })

    const listed = listSessions('/projA', dir)
    expect(listed.length).toBe(1)
    expect(listed[0].file).toBe(a.file)
    expect(listed[0].preview).toBe('任务A')
  })

  it('listSessions 忽略损坏的 jsonl 文件不崩溃', () => {
    nodeFs.writeFileSync(path.join(dir, 'broken.jsonl'), '{not json')
    expect(() => listSessions('/x', dir)).not.toThrow()
  })

  it('meta 行字段缺失时用默认值兜底，不产生 undefined', () => {
    const fsmod = nodeFs
    const f = path.join(dir, 'partial.jsonl')
    fsmod.writeFileSync(f, JSON.stringify({ t: 'meta', cwd: '/p' }) + '\n')
    const loaded = loadSession(f)
    expect(loaded.meta.cwd).toBe('/p')
    expect(loaded.meta.model).toBe('deepseek-v4-flash')
    expect(loaded.meta.thinking).toBe(false)
    expect(loaded.meta.permMode).toBe('default')
  })

  it('assistant content 为 null 时往返保真（无文本工具调用轮）', () => {
    const h = newSession(meta('/p'), dir)
    h.appendMessage({ role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'Read', arguments: '{}' } }] })
    const loaded = loadSession(h.file)
    expect(loaded.messages[0].content).toBeNull()
    expect(loaded.messages[0].tool_calls[0].id).toBe('t1')
  })

  it('loadSession 给悬空 tool_calls 补合成 tool 结果，保证可恢复', () => {
    const h = newSession(meta('/p'), dir)
    h.appendMessage({ role: 'user', content: '改个文件' })
    h.appendMessage({
      role: 'assistant', content: null, tool_calls: [
        { id: 'a1', type: 'function', function: { name: 'Read', arguments: '{}' } },
        { id: 'a2', type: 'function', function: { name: 'Edit', arguments: '{}' } },
      ],
    })
    // 崩溃/截断：两条 tool 结果都没落盘
    const loaded = loadSession(h.file)
    const tail = loaded.messages.slice(-2)
    expect(tail.map(m => m.role)).toEqual(['tool', 'tool'])
    expect(tail.map(m => m.tool_call_id).sort()).toEqual(['a1', 'a2'])
    expect(tail[0].content).toBe('（中断，无结果）')
  })

  it('loadSession 不动已正常应答的 tool_calls', () => {
    const h = newSession(meta('/p'), dir)
    h.appendMessage({ role: 'assistant', content: null, tool_calls: [{ id: 'ok1', type: 'function', function: { name: 'Read', arguments: '{}' } }] })
    h.appendMessage({ role: 'tool', tool_call_id: 'ok1', content: '文件内容' })
    h.appendMessage({ role: 'assistant', content: '读完了' })
    const loaded = loadSession(h.file)
    expect(loaded.messages.length).toBe(3)
    expect(loaded.messages[1]).toEqual({ role: 'tool', tool_call_id: 'ok1', content: '文件内容' })
  })

  it('落盘失败不抛异常（改为仅内存，stderr 警告一次）', () => {
    const h = openSession(path.join(dir, '不存在的子目录', 'x.jsonl'))
    expect(() => h.appendMessage({ role: 'user', content: 'hi' })).not.toThrow()
    expect(() => h.appendUsage({ prompt_tokens: 1, completion_tokens: 1, prompt_cache_hit_tokens: 0 }, 'm')).not.toThrow()
  })

  it('appendMeta 追加 meta 行，loadSession 以最后一条为准', () => {
    const h = newSession(meta('/p'), dir)
    h.appendMeta({ cwd: '/p', model: 'deepseek-v4-pro', thinking: true, permMode: 'acceptEdits' })
    const loaded = loadSession(h.file)
    expect(loaded.meta.model).toBe('deepseek-v4-pro')
    expect(loaded.meta.thinking).toBe(true)
    expect(loaded.meta.permMode).toBe('acceptEdits')
  })
})
