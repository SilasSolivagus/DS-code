import { describe, it, expect, vi } from 'vitest'

vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>()
  const { mkdtempSync } = await import('node:fs')
  const path = await import('node:path')
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'dc-deny-'))
  const homedir = () => fakeHome
  return { ...os, homedir, default: { ...os, homedir } }
})

import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { saveRawUserSettings, loadRawUserSettings, listUserDenyRules, removeUserAllowRuleByValue, removeUserDenyRuleByValue } from '../src/config.js'

const settingsFile = path.join(os.homedir(), '.deepcode', 'settings.json')

function seed(allow: string[], deny: string[]) {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
  const s = loadRawUserSettings()
  s.permissions.allow = [...allow]
  s.permissions.deny = [...deny]
  saveRawUserSettings(s)
}

describe('config 按值删 helper（hermetic）', () => {
  it('listUserDenyRules 读 user deny；缺失返回 []', () => {
    seed([], [])
    expect(listUserDenyRules()).toEqual([])
    seed([], ['Bash(rm -rf:*)'])
    expect(listUserDenyRules()).toEqual(['Bash(rm -rf:*)'])
  })
  it('removeUserAllowRuleByValue 命中删返 true, 不误删其它值', () => {
    seed(['Bash(npm test:*)', 'Read(./a)'], [])
    expect(removeUserAllowRuleByValue('Bash(npm test:*)')).toBe(true)
    expect(loadRawUserSettings().permissions.allow).toEqual(['Read(./a)'])
  })
  it('removeUserAllowRuleByValue 未命中返 false', () => {
    seed(['Read(./a)'], [])
    expect(removeUserAllowRuleByValue('Bash(nope)')).toBe(false)
    expect(loadRawUserSettings().permissions.allow).toEqual(['Read(./a)'])
  })
  it('removeUserDenyRuleByValue 命中删返 true；deny 缺失返 false', () => {
    seed([], ['Bash(rm -rf:*)'])
    expect(removeUserDenyRuleByValue('Bash(rm -rf:*)')).toBe(true)
    expect(loadRawUserSettings().permissions.deny ?? []).toEqual([])
    seed([], [])
    expect(removeUserDenyRuleByValue('Bash(x)')).toBe(false)
  })
})
