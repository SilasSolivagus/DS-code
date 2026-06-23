import { describe, it, expect } from 'vitest'
import { modelList, BUILTIN_PROVIDERS } from '../src/providers.js'

describe('modelList /model 选择器列表', () => {
  it('glm provider 列出全部 meta 档 + fast/smart 别名行', () => {
    const items = modelList(BUILTIN_PROVIDERS.glm, 'glm-5.2')
    const ids = items.map(i => i.id)
    // 别名行在前（解析到具体 id）
    expect(ids.slice(0, 2)).toEqual(['glm-5-turbo', 'glm-5.2']) // [fast]→turbo [smart]→5.2
    // 全部 8 个 meta 档都在
    for (const k of Object.keys(BUILTIN_PROVIDERS.glm.meta)) expect(ids).toContain(k)
  })

  it('当前模型行带 ● 标记', () => {
    const items = modelList(BUILTIN_PROVIDERS.glm, 'glm-5.2')
    const cur = items.find(i => i.id === 'glm-5.2' && i.label.startsWith('●'))
    expect(cur).toBeDefined()
  })

  it('label 含 window 与三段价格', () => {
    const items = modelList(BUILTIN_PROVIDERS.glm, 'glm-5-turbo')
    const turbo = items.find(i => i.id === 'glm-5-turbo' && !i.label.includes('档（'))!
    expect(turbo.label).toContain('200k')
    expect(turbo.label).toContain('¥0.2') // hit
    expect(turbo.label).toContain('¥3')   // out
  })

  it('别名行 label 标注 fast/smart 语义', () => {
    const items = modelList(BUILTIN_PROVIDERS.glm, 'glm-5.2')
    expect(items[0].label).toContain('fast')
    expect(items[1].label).toContain('smart')
  })
})
