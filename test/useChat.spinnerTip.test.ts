import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { computeSpinnerTip } from '../src/tui/useChat.js'

let file: string
beforeEach(() => { file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-uct-')), 'state.json') })
afterEach(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }))

describe('computeSpinnerTip', () => {
  it('spinnerTips=false 时返回 null 且不写盘', () => {
    expect(computeSpinnerTip({ spinnerTips: false }, file, () => 0)).toBeNull()
    expect(fs.existsSync(file)).toBe(false)
  })

  it('默认开启：选一条 tip 并持久化 startupCount+1 与历史', () => {
    const tip = computeSpinnerTip({}, file, () => 0)
    expect(typeof tip).toBe('string')
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(saved.startupCount).toBe(1)
    expect(Object.keys(saved.tipsHistory).length).toBe(1)
  })

  it('连续两次启动：startupCount 递增', () => {
    computeSpinnerTip({}, file, () => 0)
    computeSpinnerTip({}, file, () => 0)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).startupCount).toBe(2)
  })
})
