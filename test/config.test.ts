import { describe, it, expect, vi, beforeEach } from 'vitest'

// src/config.ts 在模块加载时就计算 DIR = path.join(os.homedir(), '.deepcode')，
// 所以必须在 import 之前把 node:os 的 homedir mock 到临时目录（含 default 导出形态）。
// mock runHooks 捕获调用；vi.mock 被 vitest hoisted，config.ts 加载时拿到的是 mock 版本。
const hookCalls: Array<{ event: string; payload: any }> = []
vi.mock('../src/hooks.js', async orig => ({
  ...(await orig() as any),
  runHooks: vi.fn(async (event: string, payload: any) => {
    hookCalls.push({ event, payload })
    return { block: false, preventContinuation: false, stop: false, results: [] }
  }),
}))

vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>()
  const { mkdtempSync } = await import('node:fs')
  const path = await import('node:path')
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'dc-conf-'))
  const homedir = () => fakeHome
  return { ...os, homedir, default: { ...os, homedir } }
})

import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { loadSettings, loadRawUserSettings, saveRawUserSettings, saveApiKey, hasApiKey, parseHooksConfig, parsePermissions, parseStringArray, addUserAllowRule, removeUserAllowRule } from '../src/config.js'

const fakeHome = os.homedir()
const settingsFile = path.join(fakeHome, '.deepcode', 'settings.json')

describe('settings 默认值（hermetic：homedir 已 mock 到临时目录）', () => {
  it('文件缺失时给出精确默认值', () => {
    expect(fs.existsSync(settingsFile)).toBe(false)
    const s = loadSettings()
    expect(s.compactTokens).toBeUndefined()
    expect(s.costWarnCNY).toBe(15)
    expect(s.costWarnCNY).toBeGreaterThan(0)
    expect(s.permissions.allow).toEqual([])
  })
})

describe('compactTokens optional（Task4）', () => {
  it('未设 compactTokens → loadSettings 返回 undefined（不再注默认 200k）', () => {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
    fs.writeFileSync(settingsFile, JSON.stringify({ costWarnCNY: 15 }))
    const s = loadSettings()
    expect(s.compactTokens).toBeUndefined()
  })

  it('显式设 compactTokens 保留', () => {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
    fs.writeFileSync(settingsFile, JSON.stringify({ compactTokens: 200_000 }))
    const s = loadSettings()
    expect(s.compactTokens).toBe(200_000)
  })

  it('loadRawUserSettings 未设 compactTokens → undefined', () => {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
    fs.writeFileSync(settingsFile, JSON.stringify({ costWarnCNY: 5 }))
    const s = loadRawUserSettings()
    expect(s.compactTokens).toBeUndefined()
  })
})

describe('settings 读写 round-trip', () => {
  it('saveRawUserSettings 后 loadSettings 原样读回，且写入的是 mock home', () => {
    saveRawUserSettings({
      permissions: { allow: ['Bash(ls)'] },
      compactTokens: 50_000,
      costWarnCNY: 5,
      maxToolResultChars: 100_000,
    })
    expect(fs.existsSync(settingsFile)).toBe(true) // mock 确实生效
    const s = loadSettings()
    expect(s.permissions.allow).toEqual(['Bash(ls)'])
    expect(s.compactTokens).toBe(50_000)
    expect(s.costWarnCNY).toBe(5)
    expect(s.maxToolResultChars).toBe(100_000)
  })

  it('直接写入 fakeHome 的 settings.json 也能读到（确认 mock 被命中）', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ compactTokens: 123 }))
    const s = loadSettings()
    expect(s.compactTokens).toBe(123)
    expect(s.costWarnCNY).toBe(15) // 缺省字段回落默认
    expect(s.permissions.allow).toEqual([])
  })

  it('settings 支持 model/baseURL 自定义，缺省为 undefined', () => {
    const s = loadRawUserSettings()
    expect('model' in s).toBe(true)
    expect('baseURL' in s).toBe(true)
    expect(s.model).toBeUndefined()
    expect(s.baseURL).toBeUndefined()
  })

  it('向后兼容：旧键 costWarnUSD 仍被 loadRawUserSettings 读取（fallback 到 costWarnCNY）', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ costWarnUSD: 8 }))
    const s = loadRawUserSettings()
    expect(s.costWarnCNY).toBe(8)
  })

  it('新键 costWarnCNY 优先于旧键 costWarnUSD', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ costWarnCNY: 20, costWarnUSD: 8 }))
    const s = loadSettings()
    expect(s.costWarnCNY).toBe(20)
  })
})

describe('apiKey 持久化', () => {
  it('saveApiKey 写入并能读回，loadSettings 含 apiKey', () => {
    saveApiKey('sk-test-123')
    expect(loadSettings().apiKey).toBe('sk-test-123')
  })

  it('hasApiKey：env 优先，否则看 settings', () => {
    delete process.env.DEEPSEEK_API_KEY
    saveApiKey('sk-from-settings')
    expect(hasApiKey()).toBe(true)
    saveApiKey('')
    expect(hasApiKey()).toBe(false)
    process.env.DEEPSEEK_API_KEY = 'sk-from-env'
    expect(hasApiKey()).toBe(true)
    delete process.env.DEEPSEEK_API_KEY
  })
})

describe('parseHooksConfig', () => {
  it('合法 hooks 原样返回', () => {
    const raw = { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'x' }] }] }
    expect(parseHooksConfig(raw)).toEqual(raw)
  })
  it('非对象 → undefined', () => {
    expect(parseHooksConfig(null)).toBeUndefined()
    expect(parseHooksConfig('x')).toBeUndefined()
  })
  it('丢弃未知事件键与结构非法的 matcher 条目', () => {
    const raw = { Bogus: [{ hooks: [] }], PreToolUse: [{ hooks: [{ type: 'command', command: 'ok' }] }, { foo: 1 }] }
    const out = parseHooksConfig(raw)!
    expect((out as any).Bogus).toBeUndefined()
    expect(out.PreToolUse!.length).toBe(1)
  })
})

describe('saveApiKey Setup hook', () => {
  beforeEach(() => { hookCalls.length = 0 })

  it('已配置 hooks 时写 key → Setup(trigger=init) 触发', async () => {
    saveRawUserSettings({ permissions: { allow: [] }, compactTokens: 200000, costWarnCNY: 2, hooks: { Setup: [{ hooks: [{ type: 'command', command: 'true' }] }] } } as any)
    saveApiKey('sk-test')
    await new Promise(r => setImmediate(r))
    const setup = hookCalls.find(c => c.event === 'Setup')
    expect(setup).toBeTruthy()
    expect(setup!.payload.trigger).toBe('init')
  })

  it('未配置 hooks 时写 key → 不触发 Setup', async () => {
    saveRawUserSettings({ permissions: { allow: [] }, compactTokens: 200000, costWarnCNY: 2 } as any)
    saveApiKey('sk-test2')
    await new Promise(r => setImmediate(r))
    expect(hookCalls.find(c => c.event === 'Setup')).toBeFalsy()
  })

  it('已有落盤 key 再改 → Setup(trigger=maintenance)', async () => {
    saveRawUserSettings({ permissions: { allow: [] }, compactTokens: 200000, costWarnCNY: 2, apiKey: 'sk-old', hooks: { Setup: [{ hooks: [{ type: 'command', command: 'true' }] }] } } as any)
    hookCalls.length = 0
    saveApiKey('sk-changed')
    await new Promise(r => setTimeout(r, 0))
    const setup = hookCalls.find(c => c.event === 'Setup')
    expect(setup).toBeTruthy()
    expect(setup!.payload.trigger).toBe('maintenance')
  })
})

describe('parsePermissions', () => {
  it('解析 permissions.deny（过滤非法项）', () => {
    const raw = { permissions: { allow: ['Bash(ls:*)'], deny: ['**/x', '', 123, '  **/y  '] } }
    const out = parsePermissions(raw)
    expect(out).toEqual({ allow: ['Bash(ls:*)'], deny: ['**/x', '**/y'] })
  })
})

describe('parseStringArray', () => {
  it('过滤非字符串、trim、去空', () => {
    expect(parseStringArray(['https://a.com', '  https://b.com  ', 42, ''])).toEqual(['https://a.com', 'https://b.com'])
  })
  it('非数组返回 undefined', () => {
    expect(parseStringArray('x')).toBeUndefined()
    expect(parseStringArray(undefined)).toBeUndefined()
  })
  it('空数组返回空数组（区分「全禁」语义）', () => {
    expect(parseStringArray([])).toEqual([])
  })
})

describe('raw user settings 读写', () => {
  it('saveRawUserSettings 后 loadRawUserSettings 往返', () => {
    const before = loadRawUserSettings()
    const probe = { ...before, costWarnCNY: 42 }
    saveRawUserSettings(probe)
    try {
      expect(loadRawUserSettings().costWarnCNY).toBe(42)
    } finally {
      saveRawUserSettings(before) // 还原，避免污染真 ~/.deepcode
    }
  })
})

describe('user-scope allow 规则 RMW', () => {
  it('add 只动 user.permissions.allow，不引入其它 scope 字段', () => {
    const before = loadRawUserSettings()
    try {
      addUserAllowRule('Bash(echo:*)')
      const after = loadRawUserSettings()
      expect(after.permissions.allow).toContain('Bash(echo:*)')
      const removed = removeUserAllowRule(after.permissions.allow.indexOf('Bash(echo:*)'))
      expect(removed).toBe('Bash(echo:*)')
      expect(loadRawUserSettings().permissions.allow).not.toContain('Bash(echo:*)')
    } finally { saveRawUserSettings(before) }
  })
})
