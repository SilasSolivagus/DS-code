import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChatCore } from '../src/tui/useChat.js'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-rw-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('useChat /rewind 契约', () => {
  it('ChatCore 暴露 rewindList/rewind；初始无还原点', () => {
    const core = createChatCore({ client: {} as any, yolo: false, cwd: '/tmp', sessionDir: dir, onState: () => {} })
    expect(typeof core.rewindList).toBe('function')
    expect(typeof core.rewind).toBe('function')
    expect(core.rewindList()).toEqual([])
  })
})
