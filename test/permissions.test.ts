import { describe, it, expect } from 'vitest'
import { matchRule, checkPermission, type PermissionContext, type Decision } from '../src/permissions.js'

const fakeTool = (name: string, isReadOnly: boolean, desc: false | string = 'x'): any => ({
  name,
  isReadOnly,
  needsPermission: () => desc,
})

function pc(over: Partial<PermissionContext> = {}): PermissionContext {
  return {
    mode: 'default',
    rules: [],
    saveRule: () => {},
    ask: async () => 'no' as Decision,
    ...over,
  }
}

describe('matchRule', () => {
  it('前缀规则与精确规则', () => {
    expect(matchRule('Bash(npm test:*)', 'Bash', 'npm test -- --watch')).toBe(true)
    expect(matchRule('Bash(npm test:*)', 'Bash', 'npm install x')).toBe(false)
    expect(matchRule('Bash(ls)', 'Bash', 'ls')).toBe(true)
    expect(matchRule('Bash(ls)', 'Bash', 'ls -la')).toBe(false)
    expect(matchRule('Bash(ls:*)', 'Edit', 'ls')).toBe(false)
  })
})

describe('checkPermission', () => {
  it('只读工具直接放行，不询问', async () => {
    let asked = false
    const r = await checkPermission(fakeTool('Read', true), {}, pc({ ask: async () => { asked = true; return 'yes' } }))
    expect(r.ok).toBe(true)
    expect(asked).toBe(false)
  })

  it('yolo 模式全放行', async () => {
    const r = await checkPermission(fakeTool('Bash', false, 'rm -rf /x'), {}, pc({ mode: 'yolo' }))
    expect(r.ok).toBe(true)
  })

  it('用户拒绝时返回 reason', async () => {
    const r = await checkPermission(fakeTool('Bash', false, 'npm i'), {}, pc({ ask: async () => 'no' }))
    expect(r).toEqual({ ok: false, reason: '用户拒绝了此操作' })
  })

  it('always 持久化规则且后续命中不再询问', async () => {
    const rules: string[] = []
    let asks = 0
    const ctx = pc({ rules, saveRule: r => rules.push(r), ask: async () => { asks++; return 'always' } })
    const tool = fakeTool('Bash', false, 'npm test')
    expect((await checkPermission(tool, {}, ctx)).ok).toBe(true)
    expect((await checkPermission(tool, {}, ctx)).ok).toBe(true)
    expect(asks).toBe(1)
    expect(rules).toEqual(['Bash(npm test:*)'])
  })

  it('acceptEdits 放行 Edit/Write，Bash 仍询问', async () => {
    let asked = false
    const ctx = pc({ mode: 'acceptEdits', ask: async () => { asked = true; return 'yes' } })
    expect((await checkPermission(fakeTool('Edit', false, '改文件'), {}, ctx)).ok).toBe(true)
    expect(asked).toBe(false)
    await checkPermission(fakeTool('Bash', false, 'npm i'), {}, ctx)
    expect(asked).toBe(true)
  })
})
