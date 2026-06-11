import { describe, it, expect } from 'vitest'
import { matchRule, checkPermission, isDangerous, type PermissionContext, type Decision } from '../src/permissions.js'

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

  it('前缀匹配有词边界，ls 不匹配 lsof', () => {
    expect(matchRule('Bash(ls:*)', 'Bash', 'ls -la')).toBe(true)
    expect(matchRule('Bash(ls:*)', 'Bash', 'ls')).toBe(true)
    expect(matchRule('Bash(ls:*)', 'Bash', 'lsof -i :3000')).toBe(false)
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

  it('多行命令 always 后第一行前缀规则可命中', async () => {
    const rules: string[] = []
    let asks = 0
    const ctx = pc({ rules, saveRule: r => rules.push(r), ask: async () => { asks++; return 'always' } })
    const tool = fakeTool('Bash', false, 'npm install\nnpm test')
    expect((await checkPermission(tool, {}, ctx)).ok).toBe(true)
    expect(rules).toEqual(['Bash(npm install:*)'])
    // 后续单行同前缀命令命中规则，不再询问
    const tool2 = fakeTool('Bash', false, 'npm install lodash')
    expect((await checkPermission(tool2, {}, ctx)).ok).toBe(true)
    expect(asks).toBe(1)
  })
})

describe('isDangerous', () => {
  it('识别高危命令', () => {
    expect(isDangerous('rm -rf /tmp/x')).toBe(true)
    expect(isDangerous('rm -fr node_modules')).toBe(true)
    expect(isDangerous('sudo rm file')).toBe(true)
    expect(isDangerous('git push --force')).toBe(true)
    expect(isDangerous('git reset --hard HEAD~1')).toBe(true)
    expect(isDangerous('DROP TABLE users')).toBe(true)
  })
  it('普通命令不误报', () => {
    expect(isDangerous('npm test')).toBe(false)
    expect(isDangerous('rm file.txt')).toBe(false)
    expect(isDangerous('ls -la')).toBe(false)
    expect(isDangerous('git status --porcelain')).toBe(false)
  })
})

describe('checkPermission 高危分支', () => {
  it('高危命令 always 只持久化精确规则，不做前缀放宽', async () => {
    const rules: string[] = []
    const ctx = pc({ rules, saveRule: r => rules.push(r), ask: async () => 'always' })
    const tool = fakeTool('Bash', false, 'rm -rf /tmp/scratch')
    expect((await checkPermission(tool, {}, ctx)).ok).toBe(true)
    expect(rules).toEqual(['Bash(rm -rf /tmp/scratch)'])
    // 精确规则不匹配其他 rm -rf
    const tool2 = fakeTool('Bash', false, 'rm -rf /etc')
    let asked = false
    const ctx2 = pc({ rules, ask: async () => { asked = true; return 'no' } })
    await checkPermission(tool2, {}, ctx2)
    expect(asked).toBe(true)
  })
})
