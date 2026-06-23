import { describe, it, expect } from 'vitest'
import { isInsideWorkspace } from '../src/workspace.js'

describe('isInsideWorkspace', () => {
  it('cwd 内的文件 → true', () => {
    expect(isInsideWorkspace('/proj/src/a.ts', ['/proj'])).toBe(true)
  })
  it('root 自身 → true', () => {
    expect(isInsideWorkspace('/proj', ['/proj'])).toBe(true)
  })
  it('cwd 外 → false', () => {
    expect(isInsideWorkspace('/etc/passwd', ['/proj'])).toBe(false)
  })
  it('命中白名单第二个 root → true', () => {
    expect(isInsideWorkspace('/extra/x.ts', ['/proj', '/extra'])).toBe(true)
  })
  it('前缀相同但非子目录（/proj-evil）→ false', () => {
    expect(isInsideWorkspace('/proj-evil/x', ['/proj'])).toBe(false)
  })
})
