import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { makeSessionFileTool, runSessionMemoryUpdate } from '../src/services/memory/sessionMemory.js'

describe('makeSessionFileTool', () => {
  let dir: string, p: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-sf-')); p = path.join(dir, 'summary.md'); fs.writeFileSync(p, 'A B C') })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })
  test('编辑目标文件成功', async () => {
    const t = makeSessionFileTool(p)
    const r = await t.call({ file_path: p, old_string: 'B', new_string: 'X' }, {} as any)
    expect(fs.readFileSync(p, 'utf8')).toBe('A X C')
  })
  test('拒绝其它文件', async () => {
    const t = makeSessionFileTool(p)
    const other = path.join(dir, 'other.md'); fs.writeFileSync(other, 'z')
    const r = await t.call({ file_path: other, old_string: 'z', new_string: 'q' }, {} as any)
    expect(r).toMatch(/拒绝|只能/)
    expect(fs.readFileSync(other, 'utf8')).toBe('z')
  })
})

test('runSessionMemoryUpdate 调 runSubagent（fail-safe）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-su-'))
  const p = path.join(dir, 'summary.md')
  const runSub = vi.fn(async () => 'ok')
  await runSessionMemoryUpdate({ client: {} as any, model: 'm', absPath: p, ctx: { signal: new AbortController().signal } as any, runSubagent: runSub })
  expect(runSub).toHaveBeenCalled()
  const runSubBad = vi.fn(async () => { throw new Error('x') })
  await expect(runSessionMemoryUpdate({ client: {} as any, model: 'm', absPath: p, ctx: { signal: new AbortController().signal } as any, runSubagent: runSubBad })).resolves.toBeUndefined()
  fs.rmSync(dir, { recursive: true, force: true })
})
