import { describe, it, expect } from 'vitest'
import { stripUntrustedScope } from '../src/settingsLayers.js'

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
