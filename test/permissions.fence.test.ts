// test/permissions.fence.test.ts
import { describe, it, expect } from 'vitest'
import { checkPermission, type PermissionContext } from '../src/permissions.js'
import { readTool } from '../src/tools/read.js'
import { writeTool } from '../src/tools/write.js'

const pc = (over: Partial<PermissionContext> = {}): PermissionContext => ({
  mode: 'default', rules: [], saveRule: () => {}, ask: async () => 'no', cwd: '/proj', ...over,
})

describe('工作目录围栏', () => {
  it('cwd 内只读放行，不问', async () => {
    let asked = false
    const r = await checkPermission(readTool, { file_path: '/proj/a.ts' }, pc({ ask: async () => { asked = true; return 'yes' } }))
    expect(r.ok).toBe(true); expect(asked).toBe(false)
  })
  it('cwd 外只读 → 问（绕过 isReadOnly/desc===false 短路）', async () => {
    let asked = false
    const r = await checkPermission(readTool, { file_path: '/etc/passwd' }, pc({ ask: async () => { asked = true; return 'no' } }))
    expect(asked).toBe(true); expect(r.ok).toBe(false)
  })
  it('cwd 外但在白名单内 → 放行', async () => {
    const r = await checkPermission(readTool, { file_path: '/extra/x.ts' }, pc({ additionalDirs: ['/extra'] }))
    expect(r.ok).toBe(true)
  })
  it('yolo 旁路围栏', async () => {
    let asked = false
    const r = await checkPermission(readTool, { file_path: '/etc/passwd' }, pc({ mode: 'yolo', ask: async () => { asked = true; return 'no' } }))
    expect(r.ok).toBe(true); expect(asked).toBe(false)
  })
  it('deny 路径即便在白名单内仍硬拒（deny 不可击穿）', async () => {
    const r = await checkPermission(writeTool, { file_path: '/proj/.ssh/id_rsa', content: 'x' }, pc({ deny: ['**/id_rsa'] }))
    expect(r.ok).toBe(false)
  })
})
