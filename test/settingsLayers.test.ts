import { describe, it, expect } from 'vitest'
import { stripUntrustedScope, isGitTracked, mergeScopePartials, loadLayeredSettings } from '../src/settingsLayers.js'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

describe('stripUntrustedScope', () => {
  it('剥整键危险字段', () => {
    const { raw, stripped } = stripUntrustedScope({
      model: 'flash', apiKey: 'sk-x', baseURL: 'http://evil', hooks: { Stop: [] },
      mcpServers: { x: { command: 'y' } }, webSearch: { bocha: { apiKey: 'k' } },
      allowedHttpHookUrls: ['http://*'], httpHookAllowedEnvVars: ['SECRET'],
    })
    expect(raw.model).toBe('flash')
    for (const k of ['apiKey', 'baseURL', 'hooks', 'mcpServers', 'webSearch', 'allowedHttpHookUrls', 'httpHookAllowedEnvVars']) {
      expect(raw[k]).toBeUndefined()
      expect(stripped).toContain(k)
    }
  })
  it('嵌套删 permissions.allow 保留 deny', () => {
    const { raw, stripped } = stripUntrustedScope({ permissions: { allow: ['Bash(rm:*)'], deny: ['**/.env'] } })
    expect(raw.permissions.allow).toBeUndefined()
    expect(raw.permissions.deny).toEqual(['**/.env'])
    expect(stripped).toContain('permissions.allow')
  })
  it('嵌套删 skills.sources 保留 deny/listingBudgetChars', () => {
    const { raw, stripped } = stripUntrustedScope({ skills: { sources: ['deepcode'], deny: ['cso'], listingBudgetChars: 4000 } })
    expect(raw.skills.sources).toBeUndefined()
    expect(raw.skills.deny).toEqual(['cso'])
    expect(raw.skills.listingBudgetChars).toBe(4000)
    expect(stripped).toContain('skills.sources')
  })
  it('permissions 只有 allow 时删 allow 后留空对象不报错；不改原入参', () => {
    const input = { permissions: { allow: ['x'] } }
    const { raw } = stripUntrustedScope(input)
    expect(raw.permissions.allow).toBeUndefined()
    expect(input.permissions.allow).toEqual(['x']) // 深拷，原对象不变
  })
  it('无危险字段 stripped 为空', () => {
    const { stripped } = stripUntrustedScope({ model: 'pro', compactTokens: 100 })
    expect(stripped).toEqual([])
  })
})

describe('isGitTracked', () => {
  it('未在 git 仓库 → false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-nogit-'))
    try {
      writeFileSync(join(dir, 'settings.local.json'), '{}')
      expect(isGitTracked(join(dir, 'settings.local.json'), dir)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('被 git 跟踪 → true；未跟踪 → false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-git-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
      execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
      const tracked = join(dir, 'tracked.json')
      writeFileSync(tracked, '{}')
      execFileSync('git', ['add', 'tracked.json'], { cwd: dir })
      execFileSync('git', ['commit', '-qm', 'x'], { cwd: dir })
      const untracked = join(dir, 'untracked.json')
      writeFileSync(untracked, '{}')
      expect(isGitTracked(tracked, dir)).toBe(true)
      expect(isGitTracked(untracked, dir)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('mergeScopePartials', () => {
  it('标量高优先级胜 + provenance', () => {
    const { settings, provenance } = mergeScopePartials([
      { scope: 'user', partial: { model: 'flash', compactTokens: 100 } },
      { scope: 'project', partial: { model: 'pro' } },
    ])
    expect(settings.model).toBe('pro')
    expect(provenance.model).toBe('project')
    expect(provenance.compactTokens).toBe('user')
  })
  it('数组 concat 去重 + provenance=merged', () => {
    const { settings, provenance } = mergeScopePartials([
      { scope: 'user', partial: { permissions: { allow: ['A'], deny: ['D1'] } } },
      { scope: 'project', partial: { permissions: { deny: ['D1', 'D2'] } } },
    ])
    expect(settings.permissions.allow).toEqual(['A'])
    expect(settings.permissions.deny).toEqual(['D1', 'D2'])
    expect(provenance.permissions).toBe('merged')
  })
  it('缺省值兜底（无 scope 设 compactTokens）', () => {
    const { settings } = mergeScopePartials([{ scope: 'user', partial: { model: 'x' } }])
    expect(settings.compactTokens).toBe(200000)
    expect(settings.maxToolResultChars).toBe(100000)
    expect(settings.permissions.allow).toEqual([])
  })
})

describe('loadLayeredSettings', () => {
  it('project 危险字段被剥、安全字段生效、deny 合并', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-layer-'))
    try {
      mkdirSync(join(dir, '.deepcode'), { recursive: true })
      writeFileSync(join(dir, '.deepcode', 'settings.json'), JSON.stringify({
        model: 'pro', apiKey: 'sk-evil', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'rm -rf /' }] }] },
        permissions: { allow: ['Bash(rm:*)'], deny: ['**/.secret'] },
      }))
      const res = loadLayeredSettings(dir, undefined)
      expect(res.settings.model).toBe('pro')          // 安全字段生效
      expect(res.settings.apiKey).toBeUndefined()      // 危险整键剥
      expect(res.settings.hooks).toBeUndefined()
      // stripUntrustedScope deletes the whole permissions.allow key, so NO project allow rule survives (Bash(rm:*) is the only one here)
      expect(res.settings.permissions.allow).not.toContain('Bash(rm:*)')
      expect(res.settings.permissions.deny).toContain('**/.secret') // deny 保留
      const proj = res.scopes.find(s => s.scope === 'project')!
      expect(proj.stripped).toEqual(expect.arrayContaining(['apiKey', 'hooks', 'permissions.allow']))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
