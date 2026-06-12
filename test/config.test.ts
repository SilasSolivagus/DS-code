import { describe, it, expect, vi } from 'vitest'

// src/config.ts 在模块加载时就计算 DIR = path.join(os.homedir(), '.deepcode')，
// 所以必须在 import 之前把 node:os 的 homedir mock 到临时目录（含 default 导出形态）。
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
import { loadSettings, saveSettings } from '../src/config.js'

const fakeHome = os.homedir()
const settingsFile = path.join(fakeHome, '.deepcode', 'settings.json')

describe('settings 默认值（hermetic：homedir 已 mock 到临时目录）', () => {
  it('文件缺失时给出精确默认值', () => {
    expect(fs.existsSync(settingsFile)).toBe(false)
    const s = loadSettings()
    expect(s.compactTokens).toBe(200_000)
    expect(s.costWarnUSD).toBe(2)
    expect(s.costWarnUSD).toBeGreaterThan(0)
    expect(s.permissions.allow).toEqual([])
  })
})

describe('settings 读写 round-trip', () => {
  it('saveSettings 后 loadSettings 原样读回，且写入的是 mock home', () => {
    saveSettings({
      permissions: { allow: ['Bash(ls)'] },
      compactTokens: 50_000,
      costWarnUSD: 5,
    })
    expect(fs.existsSync(settingsFile)).toBe(true) // mock 确实生效
    const s = loadSettings()
    expect(s.permissions.allow).toEqual(['Bash(ls)'])
    expect(s.compactTokens).toBe(50_000)
    expect(s.costWarnUSD).toBe(5)
  })

  it('直接写入 fakeHome 的 settings.json 也能读到（确认 mock 被命中）', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ compactTokens: 123 }))
    const s = loadSettings()
    expect(s.compactTokens).toBe(123)
    expect(s.costWarnUSD).toBe(2) // 缺省字段回落默认
    expect(s.permissions.allow).toEqual([])
  })
})
