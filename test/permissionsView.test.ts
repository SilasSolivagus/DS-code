import { describe, it, expect } from 'vitest'
import { formatPermissionRules, resolveRuleRemoval } from '../src/permissionsView.js'

describe('formatPermissionRules', () => {
  it('两段渲染含来源标签 + 操作提示', () => {
    const out = formatPermissionRules(
      ['Bash(npm test:*)', 'Read(./src)'], { 'Bash(npm test:*)': 'user', 'Read(./src)': 'project' },
      ['**/id_rsa', 'Bash(rm -rf:*)'], { '**/id_rsa': 'builtin', 'Bash(rm -rf:*)': 'user' },
    )
    expect(out).toContain('允许规则（Allow）')
    expect(out).toContain('1. Bash(npm test:*) [用户设置]')
    expect(out).toContain('2. Read(./src) [共享项目设置]')
    expect(out).toContain('拒绝规则（Deny）')
    expect(out).toContain('1. **/id_rsa [内置规则]')
    expect(out).toContain('2. Bash(rm -rf:*) [用户设置]')
    expect(out).toContain('/permissions rm <编号>')
    expect(out).toContain('deny-rm <编号>')
  })
  it('全空 → 没有已保存的权限规则', () => {
    expect(formatPermissionRules([], {}, [], {})).toContain('没有已保存的权限规则')
  })
  it('来源缺失兜底：allow→用户, deny→内置', () => {
    const out = formatPermissionRules(['Bash(x)'], {}, ['**/y'], {})
    expect(out).toContain('1. Bash(x) [用户设置]')
    expect(out).toContain('1. **/y [内置规则]')
  })
})

describe('resolveRuleRemoval', () => {
  const list = ['Bash(a)', 'Read(b)']
  it('用户层规则 → ok + value', () => {
    expect(resolveRuleRemoval(list, 1, { 'Bash(a)': 'user' }, 'user')).toEqual({ ok: true, value: 'Bash(a)' })
  })
  it('非用户层 → 友好提示带来源', () => {
    const r = resolveRuleRemoval(list, 2, { 'Read(b)': 'project' }, 'user')
    expect(r.ok).toBe(false)
    expect((r as any).reason).toContain('共享项目设置')
  })
  it('来源缺失走默认 source', () => {
    expect(resolveRuleRemoval(['**/x'], 1, {}, 'builtin').ok).toBe(false)
    expect(resolveRuleRemoval(['Bash(a)'], 1, {}, 'user')).toEqual({ ok: true, value: 'Bash(a)' })
  })
  it('编号越界 → 无效', () => {
    expect(resolveRuleRemoval(list, 0, {}, 'user')).toEqual({ ok: false, reason: '编号无效' })
    expect(resolveRuleRemoval(list, 3, {}, 'user')).toEqual({ ok: false, reason: '编号无效' })
  })
})
