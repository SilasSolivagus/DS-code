import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ENV_FILE_EVENTS, hookEnvFileName, sessionEnvDirFor, ensureSessionEnvDir,
  getSessionEnvScript, clearCwdEnvFiles, invalidateSessionEnvCache,
} from '../src/sessionEnv.js'

let base: string
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'deepcode-senv-'))
  invalidateSessionEnvCache() // 清单槽缓存，隔离用例
})

describe('sessionEnv 基础', () => {
  it('ENV_FILE_EVENTS 恰为四事件', () => {
    expect([...ENV_FILE_EVENTS].sort()).toEqual(['CwdChanged', 'FileChanged', 'SessionStart', 'Setup'])
  })

  it('hookEnvFileName 小写事件 + index', () => {
    expect(hookEnvFileName('SessionStart', 0)).toBe('sessionstart-hook-0.sh')
    expect(hookEnvFileName('CwdChanged', 2)).toBe('cwdchanged-hook-2.sh')
  })

  it('sessionEnvDirFor 拼 base/sessionId', () => {
    expect(sessionEnvDirFor('sess-1', base)).toBe(path.join(base, 'sess-1'))
  })

  it('ensureSessionEnvDir 创建目录并返回路径', () => {
    const dir = ensureSessionEnvDir('sess-1', base)
    expect(dir).toBe(path.join(base, 'sess-1'))
    writeFileSync(path.join(dir, 'x'), 'y')
    expect(readFileSync(path.join(dir, 'x'), 'utf8')).toBe('y')
  })
})

describe('getSessionEnvScript assemble', () => {
  it('无目录 → 空串', () => {
    expect(getSessionEnvScript('nope', base)).toBe('')
  })

  it('按优先级 setup<sessionstart<cwdchanged<filechanged + index 排序拼接，trim 空文件跳过', () => {
    const dir = ensureSessionEnvDir('s', base)
    writeFileSync(path.join(dir, 'cwdchanged-hook-0.sh'), 'export C=3\n')
    writeFileSync(path.join(dir, 'sessionstart-hook-1.sh'), 'export B2=2b\n')
    writeFileSync(path.join(dir, 'sessionstart-hook-0.sh'), 'export B=2\n')
    writeFileSync(path.join(dir, 'setup-hook-0.sh'), 'export A=1\n')
    writeFileSync(path.join(dir, 'filechanged-hook-0.sh'), '   \n')
    writeFileSync(path.join(dir, 'ignore.sh'), 'export Z=9\n')
    expect(getSessionEnvScript('s', base)).toBe('export A=1\nexport B=2\nexport B2=2b\nexport C=3')
  })

  it('单槽缓存：同 sid+base 重复调用不重读（写新文件后须 invalidate 才生效）', () => {
    const dir = ensureSessionEnvDir('s', base)
    writeFileSync(path.join(dir, 'setup-hook-0.sh'), 'export A=1')
    expect(getSessionEnvScript('s', base)).toBe('export A=1')
    writeFileSync(path.join(dir, 'sessionstart-hook-0.sh'), 'export B=2')
    expect(getSessionEnvScript('s', base)).toBe('export A=1')
    invalidateSessionEnvCache('s')
    expect(getSessionEnvScript('s', base)).toBe('export A=1\nexport B=2')
  })
})

describe('clearCwdEnvFiles', () => {
  it('清空 cwdchanged-*/filechanged-* 文件内容，保留 setup/sessionstart，并失效缓存', () => {
    const dir = ensureSessionEnvDir('s', base)
    writeFileSync(path.join(dir, 'setup-hook-0.sh'), 'export A=1')
    writeFileSync(path.join(dir, 'cwdchanged-hook-0.sh'), 'export C=3')
    writeFileSync(path.join(dir, 'filechanged-hook-0.sh'), 'export F=4')
    expect(getSessionEnvScript('s', base)).toBe('export A=1\nexport C=3\nexport F=4')
    clearCwdEnvFiles('s', base)
    expect(readFileSync(path.join(dir, 'setup-hook-0.sh'), 'utf8')).toBe('export A=1')
    expect(readFileSync(path.join(dir, 'cwdchanged-hook-0.sh'), 'utf8')).toBe('')
    expect(readFileSync(path.join(dir, 'filechanged-hook-0.sh'), 'utf8')).toBe('')
    expect(getSessionEnvScript('s', base)).toBe('export A=1')
  })

  it('目录不存在 → 静默 no-op', () => {
    expect(() => clearCwdEnvFiles('absent', base)).not.toThrow()
  })
})
