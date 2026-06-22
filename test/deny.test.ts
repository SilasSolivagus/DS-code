import { describe, it, expect, vi, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { BUILTIN_DENY, isDeniedPath, resolveDenyList, buildDenySourceMap } from '../src/deny.js'

const home = os.homedir()
describe('isDeniedPath', () => {
  it('命中 ~ 展开的私钥目录', () => {
    expect(isDeniedPath(path.join(home, '.ssh/id_rsa'), BUILTIN_DENY)).toBeTruthy()
  })
  it('命中 **/id_rsa 任意位置', () => {
    expect(isDeniedPath('/tmp/backup/id_rsa', BUILTIN_DENY)).toBeTruthy()
  })
  it('命中 authorized_keys', () => {
    expect(isDeniedPath(path.join(home, '.ssh/authorized_keys'), BUILTIN_DENY)).toBeTruthy()
  })
  it('.env 默认不在 BUILTIN_DENY（不误伤）', () => {
    expect(isDeniedPath('/proj/.env', BUILTIN_DENY)).toBeNull()
    expect(isDeniedPath('/proj/.env.example', BUILTIN_DENY)).toBeNull()
  })
  it('普通文件不命中', () => {
    expect(isDeniedPath('/proj/src/index.ts', BUILTIN_DENY)).toBeNull()
  })

  // Security: homedir 含 glob 元字符时 deny 不应静默失效
  describe('homedir 含 glob 元字符（元字符转义）', () => {
    afterEach(() => { vi.restoreAllMocks() })

    it('home 含 () 时 ~/.ssh/** 仍命中私钥', () => {
      vi.spyOn(os, 'homedir').mockReturnValue('/Users/foo(bar)')
      expect(isDeniedPath('/Users/foo(bar)/.ssh/id_rsa', ['~/.ssh/**'])).not.toBeNull()
    })

    it('home 含 () 时 ~/.aws/credentials 仍命中', () => {
      vi.spyOn(os, 'homedir').mockReturnValue('/Users/foo(bar)')
      expect(isDeniedPath('/Users/foo(bar)/.aws/credentials', ['~/.aws/credentials'])).not.toBeNull()
    })
  })

  // Security: .. 路径归一后仍命中
  it('.. 归一后命中 ~/.ssh/**', () => {
    expect(isDeniedPath(path.join(home, '.ssh/../.ssh/id_rsa'), BUILTIN_DENY)).not.toBeNull()
  })

  // 公钥不误伤
  it('公钥 .pub 不命中 BUILTIN_DENY', () => {
    expect(isDeniedPath('/tmp/id_rsa.pub', BUILTIN_DENY)).toBeNull()
  })
})

describe('resolveDenyList', () => {
  it('内置与用户配置并集', () => {
    const list = resolveDenyList(['**/secret.txt'])
    expect(list).toContain('**/secret.txt')
    expect(list).toContain('~/.ssh/**')
  })

  it('undefined 返回 BUILTIN_DENY 副本', () => {
    expect(resolveDenyList(undefined)).toEqual(BUILTIN_DENY)
  })

  it('[] 返回 BUILTIN_DENY 副本', () => {
    expect(resolveDenyList([])).toEqual(BUILTIN_DENY)
  })
})

describe('buildDenySourceMap', () => {
  it('builtin 标 builtin，config 并入且同名覆盖', () => {
    const m = buildDenySourceMap({ '~/secret/**': 'user', '~/.ssh/**': 'project' })
    expect(m['**/id_rsa']).toBe('builtin')
    expect(m['~/secret/**']).toBe('user')
    expect(m['~/.ssh/**']).toBe('project') // config 覆盖 builtin 同名
  })

  it('无 config 时全为 builtin', () => {
    const m = buildDenySourceMap()
    for (const p of BUILTIN_DENY) expect(m[p]).toBe('builtin')
  })
})
