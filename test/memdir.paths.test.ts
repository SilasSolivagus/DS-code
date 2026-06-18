import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sanitizeProjectKey, findGitRoot, memdirFor, sessionMemoryPathFor } from '../src/memdir/paths.js'

describe('sanitizeProjectKey', () => {
  test('非字母数字全换 -', () => {
    expect(sanitizeProjectKey('/Users/silas/loop')).toBe('-Users-silas-loop')
    expect(sanitizeProjectKey('a.b_c d')).toBe('a-b-c-d')
  })
  test('超长截断加 hash 后缀', () => {
    const long = 'x'.repeat(300)
    const out = sanitizeProjectKey(long)
    expect(out.length).toBeLessThanOrEqual(200 + 1 + 12)
    expect(out.startsWith('x'.repeat(200) + '-')).toBe(true)
    expect(sanitizeProjectKey(long)).toBe(out) // 确定性
  })
})

describe('findGitRoot', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-git-')) })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })
  test('向上找到 .git 目录', () => {
    fs.mkdirSync(path.join(tmp, '.git'))
    const sub = path.join(tmp, 'a', 'b'); fs.mkdirSync(sub, { recursive: true })
    expect(findGitRoot(sub)).toBe(fs.realpathSync(tmp))
  })
  test('无 .git 返回 null', () => {
    expect(findGitRoot(tmp)).toBe(null)
  })
})

describe('memdirFor / sessionMemoryPathFor', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-md-')) })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })
  test('memdir 用 git root 键', () => {
    const repo = path.join(tmp, 'repo'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    const real = fs.realpathSync(repo)
    expect(memdirFor(repo, tmp)).toBe(path.join(tmp, '.deepcode', 'projects', sanitizeProjectKey(real), 'memory'))
  })
  test('非 git 用 cwd 键', () => {
    expect(memdirFor(tmp, tmp)).toBe(path.join(tmp, '.deepcode', 'projects', sanitizeProjectKey(tmp), 'memory'))
  })
  test('session-memory 用 cwd 键 + summary.md', () => {
    expect(sessionMemoryPathFor(tmp, 'sess-1', tmp))
      .toBe(path.join(tmp, '.deepcode', 'projects', sanitizeProjectKey(tmp), 'sess-1', 'session-memory', 'summary.md'))
  })
})
