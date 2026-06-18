import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shouldUpdateSessionMemory, setupSessionMemoryFile, SESSION_MEMORY_TEMPLATE } from '../src/services/memory/sessionMemory.js'
import { DEFAULT_MEMORY_CONFIG } from '../src/memdir/memoryConfig.js'

const sm = DEFAULT_MEMORY_CONFIG.sessionMemory

test('首次：未达 init token 不触发', () => {
  expect(shouldUpdateSessionMemory({ promptTokens: 5000, tokensAtLastUpdate: 0, initialized: false, toolCallsSinceUpdate: 5, lastTurnHadToolCalls: true }, sm)).toBe(false)
})
test('首次：达 init token + 工具阈值 → 触发', () => {
  expect(shouldUpdateSessionMemory({ promptTokens: 12000, tokensAtLastUpdate: 0, initialized: false, toolCallsSinceUpdate: 3, lastTurnHadToolCalls: true }, sm)).toBe(true)
})
test('达 token + 上轮无 tool_calls（自然断点）→ 触发', () => {
  expect(shouldUpdateSessionMemory({ promptTokens: 12000, tokensAtLastUpdate: 6000, initialized: true, toolCallsSinceUpdate: 0, lastTurnHadToolCalls: false }, sm)).toBe(true)
})
test('更新间隔不足 → 不触发', () => {
  expect(shouldUpdateSessionMemory({ promptTokens: 12000, tokensAtLastUpdate: 10000, initialized: true, toolCallsSinceUpdate: 5, lastTurnHadToolCalls: true }, sm)).toBe(false)
})

describe('setupSessionMemoryFile', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-sm-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })
  test('不存在 → 写模板并返回', () => {
    const p = path.join(dir, 'session-memory', 'summary.md')
    const c = setupSessionMemoryFile(p)
    expect(c).toBe(SESSION_MEMORY_TEMPLATE)
    expect(fs.readFileSync(p, 'utf8')).toBe(SESSION_MEMORY_TEMPLATE)
  })
})
