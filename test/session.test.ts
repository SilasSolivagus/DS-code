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
})
