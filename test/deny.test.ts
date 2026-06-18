import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { BUILTIN_DENY, isDeniedPath, resolveDenyList } from '../src/deny.js'

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
})
describe('resolveDenyList', () => {
  it('内置与用户配置并集', () => {
    const list = resolveDenyList(['**/secret.txt'])
    expect(list).toContain('**/secret.txt')
    expect(list).toContain('~/.ssh/**')
  })
})
