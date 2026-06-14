import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { editTool } from '../src/tools/edit.js'
import { writeTool } from '../src/tools/write.js'
import type { ToolContext } from '../src/tools/types.js'

let work: string
beforeEach(() => { work = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-bi-')) })
afterEach(() => { fs.rmSync(work, { recursive: true, force: true }) })

function makeCtx(rec?: (p: string) => void): ToolContext {
  return {
    cwd: () => work, setCwd: () => {}, signal: new AbortController().signal,
    fileState: new Map(), recordBeforeImage: rec,
  } as ToolContext
}

describe('Edit/Write before-image 钩子', () => {
  it('Write 写盘前调 recordBeforeImage（绝对路径）', async () => {
    const rec = vi.fn()
    const ctx = makeCtx(rec)
    await writeTool.call({ file_path: 'a.txt', content: 'hi' }, ctx)
    expect(rec).toHaveBeenCalledWith(path.join(work, 'a.txt'))
  })

  it('Edit 写盘前调 recordBeforeImage', async () => {
    const p = path.join(work, 'b.txt')
    fs.writeFileSync(p, 'old')
    const rec = vi.fn()
    const ctx = makeCtx(rec)
    ctx.fileState.set(p, fs.statSync(p).mtimeMs)
    await editTool.call({ file_path: 'b.txt', old_string: 'old', new_string: 'new' }, ctx)
    expect(rec).toHaveBeenCalledWith(p)
    expect(fs.readFileSync(p, 'utf8')).toBe('new')
  })

  it('无 recordBeforeImage（子代理/headless）不崩', async () => {
    const ctx = makeCtx(undefined)
    await expect(writeTool.call({ file_path: 'c.txt', content: 'x' }, ctx)).resolves.toContain('已写入')
  })
})
