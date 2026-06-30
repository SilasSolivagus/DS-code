import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadLayeredSettings } from '../src/settingsLayers.js'

describe('doneMeansMerged 设置', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-done-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('布尔解析，缺省 undefined', () => {
    // doneMeansMerged=true
    let flag = path.join(dir, 'flag1.json')
    fs.writeFileSync(flag, JSON.stringify({ doneMeansMerged: true }))
    let s = loadLayeredSettings(dir, flag).settings
    expect(s.doneMeansMerged).toBe(true)

    // doneMeansMerged=false
    flag = path.join(dir, 'flag2.json')
    fs.writeFileSync(flag, JSON.stringify({ doneMeansMerged: false }))
    s = loadLayeredSettings(dir, flag).settings
    expect(s.doneMeansMerged).toBe(false)

    // 缺省 → undefined
    flag = path.join(dir, 'flag3.json')
    fs.writeFileSync(flag, JSON.stringify({}))
    s = loadLayeredSettings(dir, flag).settings
    expect(s.doneMeansMerged).toBeUndefined()

    // 非布尔（字符串）→ undefined
    flag = path.join(dir, 'flag4.json')
    fs.writeFileSync(flag, JSON.stringify({ doneMeansMerged: 'yes' }))
    s = loadLayeredSettings(dir, flag).settings
    expect(s.doneMeansMerged).toBeUndefined()

    // 非布尔（数字）→ undefined
    flag = path.join(dir, 'flag5.json')
    fs.writeFileSync(flag, JSON.stringify({ doneMeansMerged: 1 }))
    s = loadLayeredSettings(dir, flag).settings
    expect(s.doneMeansMerged).toBeUndefined()
  })
})
