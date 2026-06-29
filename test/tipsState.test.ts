import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadAppState, saveAppState } from '../src/tipsState.js'

let dir: string
let file: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-tipsstate-'))
  file = path.join(dir, 'state.json')
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('tipsState', () => {
  it('缺失文件返回默认', () => {
    expect(loadAppState(file)).toEqual({ startupCount: 0, tipsHistory: {} })
  })

  it('往返持久化', () => {
    saveAppState({ startupCount: 7, tipsHistory: { 'a': 3 } }, file)
    expect(loadAppState(file)).toEqual({ startupCount: 7, tipsHistory: { 'a': 3 } })
  })

  it('损坏 JSON 回落默认', () => {
    fs.writeFileSync(file, '{ not json')
    expect(loadAppState(file)).toEqual({ startupCount: 0, tipsHistory: {} })
  })

  it('字段类型异常被清洗', () => {
    fs.writeFileSync(file, JSON.stringify({ startupCount: -5, tipsHistory: { a: 'x', b: 2 } }))
    expect(loadAppState(file)).toEqual({ startupCount: 0, tipsHistory: { b: 2 } })
  })
})
