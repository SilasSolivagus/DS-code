import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exitPlanModeTool, makeExitPlanModeTool } from '../../src/tools/exitPlanMode.js'
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

describe('makeExitPlanModeTool (工厂版)', () => {
  it('批准时：写盘并返回 approved:true', async () => {
    const cwd = fs.mkdtempSync(path.join(home, 'proj-'))
    const orig = process.env.HOME; process.env.HOME = home
    try {
      const approvePlan = async () => ({ approved: true })
      const tool = makeExitPlanModeTool({ approvePlan })
      const out = await tool.call({ plan: '# 计划\n步骤一' }, ctx(cwd, 'sess-approve'))
      const parsed = JSON.parse(out)
      expect(parsed.approved).toBe(true)
      expect(parsed.plan).toBe('# 计划\n步骤一')
      expect(parsed.isAgent).toBe(false)
      expect(fs.existsSync(parsed.filePath)).toBe(true)
      expect(fs.readFileSync(parsed.filePath, 'utf8')).toBe('# 计划\n步骤一')
    } finally { process.env.HOME = orig }
  })

  it('拒绝时：写盘并返回 approved:false + feedback 字段', async () => {
    const cwd = fs.mkdtempSync(path.join(home, 'proj-'))
    const orig = process.env.HOME; process.env.HOME = home
    try {
      const approvePlan = async () => ({ approved: false })
      const tool = makeExitPlanModeTool({ approvePlan })
      const out = await tool.call({ plan: '# 计划\n步骤一' }, ctx(cwd, 'sess-reject'))
      const parsed = JSON.parse(out)
      expect(parsed.approved).toBe(false)
      expect(typeof parsed.feedback).toBe('string')
      expect(parsed.feedback.length).toBeGreaterThan(0)
      // 写盘仍发生（底座行为）
      expect(fs.existsSync(parsed.filePath)).toBe(true)
    } finally { process.env.HOME = orig }
  })
})
