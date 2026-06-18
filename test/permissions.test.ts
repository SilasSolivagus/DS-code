import { describe, it, expect, vi } from 'vitest'
import { matchRule, checkPermission, isDangerous, splitBashCommand, bashCommandAllowed, type PermissionContext, type Decision } from '../src/permissions.js'

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

  it('多行命令（换行分隔）always 后存完整精确规则', async () => {
    // 换行是命令分隔符（与 && 同级），复合命令存精确规则而非前缀
    const rules: string[] = []
    let asks = 0
    const ctx = pc({ rules, saveRule: r => rules.push(r), ask: async () => { asks++; return 'always' } })
    const tool = fakeTool('Bash', false, 'npm install\nnpm test')
    expect((await checkPermission(tool, {}, ctx)).ok).toBe(true)
    expect(rules).toEqual(['Bash(npm install npm test)']) // 精确规则（\n→空格），不做前缀放宽
    // 完全相同的命令（\n→空格归一）第二次命中精确规则，不再询问
    expect((await checkPermission(tool, {}, ctx)).ok).toBe(true)
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
  it('--force-with-lease 不误报', () => {
    expect(isDangerous('git push --force-with-lease')).toBe(false)
    expect(isDangerous('git push --force')).toBe(true)
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

  it('高危多行命令 always 后，完全相同的命令第二次命中规则', async () => {
    const rules: string[] = []
    let asks = 0
    const ctx = pc({ rules, saveRule: r => rules.push(r), ask: async () => { asks++; return 'always' } })
    const tool = fakeTool('Bash', false, 'rm -rf /tmp/scratch\necho done')
    expect((await checkPermission(tool, {}, ctx)).ok).toBe(true)
    expect(rules).toEqual(['Bash(rm -rf /tmp/scratch echo done)'])
    expect((await checkPermission(tool, {}, ctx)).ok).toBe(true)
    expect(asks).toBe(1) // 第二次不再询问
  })
})

describe('splitBashCommand', () => {
  it('单命令不拆', () => {
    expect(splitBashCommand('ls -la')).toEqual({ tooComplex: false, commands: ['ls -la'] })
  })
  it('按控制操作符拆分', () => {
    expect(splitBashCommand('ls && rm -rf /').commands).toEqual(['ls', 'rm -rf /'])
    expect(splitBashCommand('a ; b | c').commands).toEqual(['a', 'b', 'c'])
  })
  it('剥重定向目标', () => {
    expect(splitBashCommand('ls > foo').commands).toEqual(['ls'])
  })
  it('引号内操作符不算分隔符', () => {
    // shell-quote 剥除引号后 "a && b" 变为字符串 token "a && b"，是预期行为（非 bug）
    expect(splitBashCommand('echo "a && b"').commands).toEqual(['echo a && b'])
  })
  it('动态构造判 too-complex', () => {
    expect(splitBashCommand('$(cat ~/.ssh/id_rsa)').tooComplex).toBe(true)
    expect(splitBashCommand('echo `whoami`').tooComplex).toBe(true)
    expect(splitBashCommand('diff <(a) <(b)').tooComplex).toBe(true)
  })
  it('$VAR 参数保留为字面量，不被空对象展开丢失', () => {
    // shell-quote 第二参传 {} 时 $HOME 被展开为 ''（丢失参数 token）
    // 修复后传函数 v=>'$'+v，$HOME 应原样保留在 token 中
    const r = splitBashCommand('cat $HOME/.ssh/id_rsa && echo $X')
    expect(r.tooComplex).toBe(false)
    expect(r.commands).toEqual(['cat $HOME/.ssh/id_rsa', 'echo $X'])
  })
})

describe('checkPermission + hooks', () => {
  const writeTool: any = {
    name: 'Write', isReadOnly: false,
    needsPermission: () => 'write /etc/passwd',
    inputSchema: { safeParse: (x: any) => ({ success: true, data: x }) },
    call: async () => 'ok',
  }
  const pc = (decision: any) => ({ mode: 'default' as const, rules: [], saveRule: () => {}, ask: async () => decision })

  it('PermissionRequest hook allow → 跳过弹窗直接放行（ask 不被调用）', async () => {
    const ask = vi.fn(async () => 'no' as const)
    const hooks = {
      onRequest: async () => ({ block: false, preventContinuation: false, stop: false, results: [], permission: 'allow' as const }),
      onDenied: vi.fn(async () => {}),
    }
    const r = await checkPermission(writeTool, {}, { mode: 'default', rules: [], saveRule: () => {}, ask }, hooks)
    expect(r.ok).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('PermissionRequest hook deny → 拒绝并触发 onDenied', async () => {
    const denied: string[] = []
    const hooks = {
      onRequest: async () => ({ block: false, preventContinuation: false, stop: false, results: [], permission: 'deny' as const, permissionReason: '禁写系统文件' }),
      onDenied: async (_n: string, _d: string, reason: string) => { denied.push(reason) },
    }
    const r = await checkPermission(writeTool, {}, pc('no'), hooks)
    expect(r.ok).toBe(false)
    expect(denied[0]).toBe('禁写系统文件')
  })

  it('用户拒绝 → onDenied 以「用户拒绝」触发', async () => {
    const denied: string[] = []
    const hooks = {
      onRequest: async () => ({ block: false, preventContinuation: false, stop: false, results: [] }),
      onDenied: async (_n: string, _d: string, reason: string) => { denied.push(reason) },
    }
    const r = await checkPermission(writeTool, {}, pc('no'), hooks)
    expect(r.ok).toBe(false)
    expect(denied[0]).toContain('用户拒绝')
  })

  it('onRequest 既非 allow 也非 deny（hook 出错/空 outcome）→ fall through 到 ask（fail-safe 问用户）', async () => {
    const ask = vi.fn(async () => 'yes' as const)
    const hooks = {
      onRequest: async () => ({ block: false, preventContinuation: false, stop: false, results: [] }),
      onDenied: vi.fn(async () => {}),
    }
    const r = await checkPermission(writeTool, {}, { mode: 'default', rules: [], saveRule: () => {}, ask }, hooks)
    expect(r.ok).toBe(true)
    expect(ask).toHaveBeenCalled() // 锁定 fail-safe：hook 未明确裁决时回落到用户审批
  })
})

describe('复合命令前缀绕过修复', () => {
  it('ls && rm 不被 Bash(ls:*) 放行', () => {
    expect(bashCommandAllowed('ls && rm -rf /', ['Bash(ls:*)'])).toBe(false)
  })
  it('每段都被覆盖才放行', () => {
    expect(bashCommandAllowed('ls && cat foo', ['Bash(ls:*)', 'Bash(cat:*)'])).toBe(true)
    expect(bashCommandAllowed('ls && cat foo', ['Bash(ls:*)'])).toBe(false)
  })
  it('单命令照旧匹配', () => {
    expect(bashCommandAllowed('ls -la', ['Bash(ls:*)'])).toBe(true)
    expect(bashCommandAllowed('lsof -i', ['Bash(ls:*)'])).toBe(false)
  })
  it('too-complex 不放行', () => {
    expect(bashCommandAllowed('$(cat ~/.ssh/id_rsa)', ['Bash(cat:*)'])).toBe(false)
  })
  it('backstop：matchRule 对含操作符的 Bash desc 不前缀匹配', () => {
    expect(matchRule('Bash(ls:*)', 'Bash', 'ls && rm -rf /')).toBe(false)
  })
})

describe('换行符命令分隔符绕过修复', () => {
  it('splitBashCommand 把未引号换行拆成两段', () => {
    expect(splitBashCommand('ls\nrm -rf /').commands).toEqual(['ls', 'rm -rf /'])
  })
  it('bashCommandAllowed: ls\\nrm -rf / 不被 Bash(ls:*) 放行（核心绕过断言）', () => {
    expect(bashCommandAllowed('ls\nrm -rf /', ['Bash(ls:*)'])).toBe(false)
  })
  it('引号内换行不拆：echo "a\\nb" 是单命令', () => {
    // shell-quote parse('echo "a\nb"') → ["echo","a\nb"]，引号内换行保留在 token
    const r = splitBashCommand('echo "a\nb"')
    expect(r.tooComplex).toBe(false)
    expect(r.commands).toEqual(['echo a\nb'])
  })
})

describe('always 存规则精确化', () => {
  it('复合命令选 always 存完整精确规则而非危险前缀', async () => {
    const saved: string[] = []
    const r = await checkPermission(
      fakeTool('Bash', false, 'ls && cat foo'),
      { command: 'ls && cat foo' },
      pc({ ask: async () => 'always', saveRule: s => saved.push(s) }),
    )
    expect(r.ok).toBe(true)
    expect(saved).toEqual(['Bash(ls && cat foo)']) // 完整精确，不是 'Bash(ls &&:*)'
  })
})
