import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parsePermissions, loadSettings } from '../src/config.js'

describe('parsePermissions defaultMode', () => {
  it('解析合法 defaultMode', () => {
    // parsePermissions takes the whole raw settings object (raw.permissions.defaultMode)
    expect(parsePermissions({ permissions: { allow: [], defaultMode: 'auto' } }).defaultMode).toBe('auto')
    expect(parsePermissions({ permissions: { allow: [], defaultMode: 'yolo' } }).defaultMode).toBe('yolo')
    expect(parsePermissions({ permissions: { allow: [], defaultMode: 'default' } }).defaultMode).toBe('default')
    expect(parsePermissions({ permissions: { allow: [], defaultMode: 'acceptEdits' } }).defaultMode).toBe('acceptEdits')
    expect(parsePermissions({ permissions: { allow: [], defaultMode: 'plan' } }).defaultMode).toBe('plan')
  })
  it('非法 defaultMode → undefined', () => {
    expect(parsePermissions({ permissions: { allow: [], defaultMode: 'bogus' } }).defaultMode).toBeUndefined()
    expect(parsePermissions({ permissions: { allow: [] } }).defaultMode).toBeUndefined()
  })
})

describe('loadSettings auto mode 顶层键', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-am-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('读 autoModeModel/autoModeThinking/disableAutoMode', () => {
    const flag = path.join(dir, 'flag.json')
    fs.writeFileSync(flag, JSON.stringify({
      autoModeModel: 'glm-5.2',
      autoModeThinking: true,
      disableAutoMode: true,
      permissions: { allow: [] },
    }))
    const s = loadSettings(dir, flag)
    expect(s.autoModeModel).toBe('glm-5.2')
    expect(s.autoModeThinking).toBe(true)
    expect(s.disableAutoMode).toBe(true)
  })

  it('disableAutoMode=false → undefined（非 true 不保留）', () => {
    const flag = path.join(dir, 'flag2.json')
    fs.writeFileSync(flag, JSON.stringify({ disableAutoMode: false }))
    const s = loadSettings(dir, flag)
    expect(s.disableAutoMode).toBeUndefined()
  })

  it('非字符串 autoModeModel → undefined', () => {
    const flag = path.join(dir, 'flag3.json')
    fs.writeFileSync(flag, JSON.stringify({ autoModeModel: 42 }))
    const s = loadSettings(dir, flag)
    expect(s.autoModeModel).toBeUndefined()
  })

  it('permissions.defaultMode 通过 loadSettings 解析', () => {
    const flag = path.join(dir, 'flag4.json')
    fs.writeFileSync(flag, JSON.stringify({ permissions: { allow: [], defaultMode: 'auto' } }))
    const s = loadSettings(dir, flag)
    expect(s.permissions.defaultMode).toBe('auto')
  })
})
