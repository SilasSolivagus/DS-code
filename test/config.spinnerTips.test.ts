import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseSpinnerTipsOverride } from '../src/config.js'
import { loadLayeredSettings } from '../src/settingsLayers.js'

describe('parseSpinnerTipsOverride', () => {
  it('合法对象保留', () => {
    expect(parseSpinnerTipsOverride({ tips: ['a', 'b'], excludeDefault: true }))
      .toEqual({ tips: ['a', 'b'], excludeDefault: true })
  })
  it('过滤非字符串 tip', () => {
    expect(parseSpinnerTipsOverride({ tips: ['a', 1, null] })).toEqual({ tips: ['a'] })
  })
  it('空/非法 → undefined', () => {
    expect(parseSpinnerTipsOverride(null)).toBeUndefined()
    expect(parseSpinnerTipsOverride({})).toBeUndefined()
    expect(parseSpinnerTipsOverride([])).toBeUndefined()
  })
})

describe('spinnerTips 分层', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-spin-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('user scope spinnerTips=false 经分层保留', () => {
    const userDir = path.join(dir, 'home', '.deepcode')
    fs.mkdirSync(userDir, { recursive: true })
    // 用 flagPath 注入用户配置文件以隔离真实 ~/.deepcode
    const flag = path.join(dir, 'flag.json')
    fs.writeFileSync(flag, JSON.stringify({ spinnerTips: false, spinnerTipsOverride: { tips: ['x'] } }))
    const s = loadLayeredSettings(dir, flag).settings
    expect(s.spinnerTips).toBe(false)
    expect(s.spinnerTipsOverride).toEqual({ tips: ['x'] })
  })
})
