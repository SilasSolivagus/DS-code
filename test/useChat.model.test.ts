import { describe, it, expect } from 'vitest'
import { modelList as plProviders, BUILTIN_PROVIDERS } from '../src/providers.js'

// 轻量验证：core.modelList() 返回的 id 集合 = providers.modelList(activeProvider, current) 的 id 集合
describe('useChat /model 核心', () => {
  it('modelList 透出 providers.modelList 全集', () => {
    const ids = plProviders(BUILTIN_PROVIDERS.deepseek, 'deepseek-v4-flash').map(i => i.id)
    expect(ids).toContain('deepseek-v4-pro')
    expect(ids).toContain('deepseek-v4-flash')
  })
})
