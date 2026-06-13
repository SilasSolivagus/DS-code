import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { VERSION } from '../src/version.js'

describe('version', () => {
  it('导出与 package.json 一致的非空版本号', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(VERSION).toBe(pkg.version)
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})
