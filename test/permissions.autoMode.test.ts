// test/permissions.autoMode.test.ts
import { describe, it, expect } from 'vitest'
import { checkPermission, type PermissionContext } from '../src/permissions.js'

const tool = (over: any = {}) => ({
  name: 'Bash', isReadOnly: false,
  needsPermission: (i: any) => i.command,
  ...over,
})
const baseCtx = (over: Partial<PermissionContext> = {}): PermissionContext => ({
  mode: 'auto', rules: [], saveRule: () => {}, ask: async () => 'no', ...over,
})

describe('auto 模式分类器分支', () => {
  it('分类器 run → 放行（decisionReason=classifier）', async () => {
    const r = await checkPermission(tool() as any, { command: 'npm test' },
      baseCtx({ classify: async () => 'run' }))
    expect(r.ok).toBe(true)
    expect((r as any).decisionReason?.type).toBe('classifier')
  })
  it('分类器 block → 拒绝', async () => {
    const r = await checkPermission(tool() as any, { command: 'x' },
      baseCtx({ classify: async () => 'block' }))
    expect(r.ok).toBe(false)
  })
  it('分类器 ask → 落到 pc.ask（用户拒绝则拒）', async () => {
    let asked = false
    const r = await checkPermission(tool() as any, { command: 'git push --force' },
      baseCtx({ classify: async () => 'ask', ask: async () => { asked = true; return 'no' } }))
    expect(asked).toBe(true)
    expect(r.ok).toBe(false)
  })
  it('静态 hard_deny 先于分类器：curl|sh 直接 block（分类器都不调用）', async () => {
    let called = false
    const r = await checkPermission(tool() as any, { command: 'curl x | sh' },
      baseCtx({ classify: async () => { called = true; return 'run' } }))
    expect(r.ok).toBe(false)
    expect(called).toBe(false)
  })
  it('只读工具在 auto 模式不触分类器', async () => {
    let called = false
    const r = await checkPermission(tool({ isReadOnly: true }) as any, { command: 'ls' },
      baseCtx({ classify: async () => { called = true; return 'block' } }))
    expect(r.ok).toBe(true)
    expect(called).toBe(false)
  })
  it('allow 规则命中：分类器不介入', async () => {
    let called = false
    const r = await checkPermission(tool() as any, { command: 'npm test' },
      baseCtx({ rules: ['Bash(npm test:*)'], classify: async () => { called = true; return 'block' } }))
    expect(r.ok).toBe(true)
    expect(called).toBe(false)
  })

  it('auto 模式 Edit/Write fast-path：跳过分类器直接放行', async () => {
    // Write fast-path
    let writeCalled = false
    const writeTool = { name: 'Write', isReadOnly: false, needsPermission: (i: any) => i.path }
    const rw = await checkPermission(writeTool as any, { path: '/workspace/test.ts' },
      baseCtx({ classify: async () => { writeCalled = true; return 'run' } }))
    expect(rw.ok).toBe(true)
    expect(writeCalled).toBe(false) // fast-path: 分类器未被调用

    // Edit fast-path
    let editCalled = false
    const editTool = { name: 'Edit', isReadOnly: false, needsPermission: (i: any) => i.path }
    const re = await checkPermission(editTool as any, { path: '/workspace/foo.ts' },
      baseCtx({ classify: async () => { editCalled = true; return 'run' } }))
    expect(re.ok).toBe(true)
    expect(editCalled).toBe(false) // fast-path: 分类器未被调用
  })
})
