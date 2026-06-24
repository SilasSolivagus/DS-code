// test/permissions.plan.test.ts
import { describe, it, expect } from 'vitest'
import { checkPermission, type PermissionContext } from '../src/permissions.js'
import { writeTool } from '../src/tools/write.js'
import { readTool } from '../src/tools/read.js'
import { bashTool } from '../src/tools/bash.js'

const basePc = (over: Partial<PermissionContext> = {}): PermissionContext => ({
  mode: 'plan', rules: [], saveRule: () => {}, ask: async () => 'no', ...over,
})

describe('plan 门', () => {
  it('plan 模式拒绝非只读工具（Write）', async () => {
    const r = await checkPermission(writeTool, { file_path: 'a.txt', content: 'x' }, basePc())
    expect(r.ok).toBe(false)
  })
  it('plan 模式放行只读工具（Read）', async () => {
    const r = await checkPermission(readTool, { file_path: 'a.txt' }, basePc({ cwd: process.cwd() }))
    expect(r.ok).toBe(true)
  })
  it('plan 模式 + 触发 deny 的非只读 Bash → 拒，不落 ask', async () => {
    let asked = false
    const r = await checkPermission(
      bashTool, { command: 'cat ~/.ssh/id_rsa' },
      basePc({ deny: ['**/id_rsa'], ask: async () => { asked = true; return 'yes' } }),
    )
    expect(r.ok).toBe(false)
    expect(asked).toBe(false)
  })
})
