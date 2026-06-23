import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exitPlanModeTool } from '../../src/tools/exitPlanMode.js'
import type { ToolContext } from '../../src/tools/types.js'

let home: string
const ctx = (cwd: string, sessionId?: string): ToolContext => ({
  cwd: () => cwd, setCwd: () => {}, signal: new AbortController().signal,
  fileState: new Map(), sessionId: () => sessionId,
} as unknown as ToolContext)

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-plan-')) })
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

describe('ExitPlanMode', () => {
  it('isReadOnly + needsPermission false', () => {
    expect(exitPlanModeTool.isReadOnly).toBe(true)
    expect(exitPlanModeTool.needsPermission({ plan: 'x' })).toBe(false)
  })
  it('写盘计划文件并返回含 filePath 的 JSON', async () => {
    const cwd = fs.mkdtempSync(path.join(home, 'proj-'))
    // 用 HOME 覆盖让 planDirFor 落到临时目录
    const orig = process.env.HOME; process.env.HOME = home
    try {
      const out = await exitPlanModeTool.call({ plan: '# 计划\n步骤一' }, ctx(cwd, 'sess1'))
      const parsed = JSON.parse(out)
      expect(parsed.plan).toBe('# 计划\n步骤一')
      expect(parsed.isAgent).toBe(false)
      expect(fs.existsSync(parsed.filePath)).toBe(true)
      expect(fs.readFileSync(parsed.filePath, 'utf8')).toBe('# 计划\n步骤一')
      expect(parsed.filePath.endsWith(path.join('plans', 'sess1.md'))).toBe(true)
    } finally { process.env.HOME = orig }
  })
})
