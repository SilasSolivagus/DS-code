import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChatCore } from '../src/tui/useChat.js'
import { listSessions } from '../src/session.js'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-fork-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('3.6 /rename + /fork', () => {
  it('/rename 写 title，listSessions 预览变标题', async () => {
    const core = createChatCore({ client: {} as any, yolo: false, cwd: '/proj', sessionDir: dir, onState: () => {} })
    await core.send('/rename 我的任务')
    const list = listSessions('/proj', dir)
    expect(list[0].preview).toBe('我的任务')
  })

  it('/fork 产出独立文件，原会话不受影响，新会话带 (Branch) 标题', async () => {
    const core = createChatCore({ client: {} as any, yolo: false, cwd: '/proj', sessionDir: dir, onState: () => {} })
    await core.send('/rename 原会话')
    const before = listSessions('/proj', dir).map(s => s.file)
    await core.send('/fork')
    const after = listSessions('/proj', dir)
    expect(after.length).toBe(before.length + 1)
    expect(after.some(s => s.preview === '原会话 (Branch)')).toBe(true)
    expect(after.some(s => s.preview === '原会话')).toBe(true)
  })
})
