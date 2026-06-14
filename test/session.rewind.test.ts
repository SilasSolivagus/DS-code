import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { newSession, loadSession } from '../src/session.js'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-sess-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('session turnId + rewind', () => {
  it('appendMessage 带 turn → loadSession 还原 messageTurnIds 与 maxTurnId', () => {
    const s = newSession({ cwd: '/x', model: 'm', thinking: false, permMode: 'default' }, dir)
    s.appendMessage({ role: 'user', content: 'q1' }, 1)
    s.appendMessage({ role: 'assistant', content: 'a1' })
    s.appendMessage({ role: 'user', content: 'q2' }, 2)
    const loaded = loadSession(s.file)
    const userIdx = loaded.messages.map((m, i) => [m, i] as const).filter(([m]) => m.role === 'user')
    expect(loaded.messageTurnIds[loaded.messages.indexOf(userIdx[0][0])]).toBe(1)
    expect(loaded.messageTurnIds[loaded.messages.indexOf(userIdx[1][0])]).toBe(2)
    expect(loaded.maxTurnId).toBe(2)
  })

  it('appendRewind 截断：丢弃 turnId>=toTurnId 的 user 消息及其后', () => {
    const s = newSession({ cwd: '/x', model: 'm', thinking: false, permMode: 'default' }, dir)
    s.appendMessage({ role: 'user', content: 'q1' }, 1)
    s.appendMessage({ role: 'assistant', content: 'a1' })
    s.appendMessage({ role: 'user', content: 'q2' }, 2)
    s.appendMessage({ role: 'assistant', content: 'a2' })
    s.appendRewind(2)
    const loaded = loadSession(s.file)
    const contents = loaded.messages.map(m => m.content)
    expect(contents).toContain('q1')
    expect(contents).toContain('a1')
    expect(contents).not.toContain('q2')
    expect(contents).not.toContain('a2')
    expect(loaded.maxTurnId).toBe(2)
  })

  it('截断后续写新轮：turnId 取更大号（不复用 2）', () => {
    const s = newSession({ cwd: '/x', model: 'm', thinking: false, permMode: 'default' }, dir)
    s.appendMessage({ role: 'user', content: 'q1' }, 1)
    s.appendMessage({ role: 'user', content: 'q2' }, 2)
    s.appendRewind(2)
    s.appendMessage({ role: 'user', content: 'q3' }, 3)
    const loaded = loadSession(s.file)
    const contents = loaded.messages.map(m => m.content)
    expect(contents).toContain('q1')
    expect(contents).not.toContain('q2')
    expect(contents).toContain('q3')
    expect(loaded.maxTurnId).toBe(3)
  })
})
