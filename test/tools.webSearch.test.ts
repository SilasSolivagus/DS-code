import { describe, it, expect } from 'vitest'
import { makeWebSearchTool, resolveWebSearchConfig } from '../src/tools/webSearchTool.js'
import type { ToolContext } from '../src/tools/types.js'

const ctx = { signal: new AbortController().signal } as unknown as ToolContext

// 注入 fetchJson：按 URL 区分 bocha/tavily 返回
function makeFetch(bocha: any[], tavily: any[], fail?: 'bocha' | 'tavily') {
  return async (url: string) => {
    if (url.includes('bochaai')) {
      if (fail === 'bocha') throw new Error('HTTP 401')
      return { data: { webPages: { value: bocha } } }
    }
    if (fail === 'tavily') throw new Error('HTTP 500')
    return { results: tavily }
  }
}

describe('makeWebSearchTool', () => {
  it('双源都配 → 合并去重', async () => {
    const fetchJson = makeFetch(
      [{ name: 'B', url: 'https://b.com', snippet: 'sb' }],
      [{ title: 'T', url: 'https://t.com', content: 'st' }],
    )
    const tool = makeWebSearchTool({ config: { bocha: 'sk', tavily: 'tv' }, fetchJson })
    const out = await tool.call({ query: 'q' }, ctx)
    expect(out).toContain('Web search results for query: "q"')
    expect(out).toContain('https://b.com')
    expect(out).toContain('https://t.com')
    expect(out).toContain('REMINDER')
  })
  it('仅一源配 key → 只查该源', async () => {
    const fetchJson = makeFetch([{ name: 'B', url: 'https://b.com', snippet: 's' }], [])
    const tool = makeWebSearchTool({ config: { bocha: 'sk' }, fetchJson })
    const out = await tool.call({ query: 'q' }, ctx)
    expect(out).toContain('https://b.com')
  })
  it('两源都无 key → 错误提示', async () => {
    const tool = makeWebSearchTool({ config: {}, fetchJson: makeFetch([], []) })
    expect(await tool.call({ query: 'q' }, ctx)).toContain('未配置任何搜索源')
  })
  it('一源 reject 一源 fulfill → 返回 fulfilled', async () => {
    const fetchJson = makeFetch([], [{ title: 'T', url: 'https://t.com', content: 's' }], 'bocha')
    const tool = makeWebSearchTool({ config: { bocha: 'sk', tavily: 'tv' }, fetchJson })
    const out = await tool.call({ query: 'q' }, ctx)
    expect(out).toContain('https://t.com')
  })
  it('两源都 reject → 错误', async () => {
    const fetchJson = async () => { throw new Error('HTTP 500') }
    const tool = makeWebSearchTool({ config: { bocha: 'sk', tavily: 'tv' }, fetchJson })
    expect(await tool.call({ query: 'q' }, ctx)).toContain('搜索失败')
  })
  it('allowed/blocked 互斥 → 错误', async () => {
    const tool = makeWebSearchTool({ config: { bocha: 'sk' }, fetchJson: makeFetch([], []) })
    const out = await tool.call({ query: 'q', allowed_domains: ['a.com'], blocked_domains: ['b.com'] }, ctx)
    expect(out).toContain('不能同时指定')
  })
  it('Bocha 客户端域名过滤（allowed 仅留命中）', async () => {
    const fetchJson = makeFetch(
      [{ name: 'keep', url: 'https://keep.com/x', snippet: 's' }, { name: 'drop', url: 'https://drop.com', snippet: 's' }],
      [],
    )
    const tool = makeWebSearchTool({ config: { bocha: 'sk' }, fetchJson })
    const out = await tool.call({ query: 'q', allowed_domains: ['keep.com'] }, ctx)
    expect(out).toContain('https://keep.com/x')
    expect(out).not.toContain('drop.com')
  })
  it('空结果 → 未找到提示', async () => {
    const tool = makeWebSearchTool({ config: { bocha: 'sk' }, fetchJson: makeFetch([], []) })
    expect(await tool.call({ query: 'q' }, ctx)).toContain('未找到结果')
  })
  it('flags：isReadOnly false，needsPermission 常量 WebSearch', () => {
    const tool = makeWebSearchTool({ config: { bocha: 'sk' }, fetchJson: makeFetch([], []) })
    expect(tool.isReadOnly).toBe(false)
    expect(tool.needsPermission({ query: 'q' })).toBe('WebSearch')
  })
})

describe('resolveWebSearchConfig', () => {
  const base = { permissions: { allow: [] }, compactTokens: 1, costWarnUSD: 1 } as any
  it('从 settings 取', () => {
    const c = resolveWebSearchConfig({ ...base, webSearch: { bocha: { apiKey: 'sk' }, tavily: { apiKey: 'tv' } } })
    expect(c).toEqual({ bocha: 'sk', tavily: 'tv' })
  })
  it('env 覆盖 settings', () => {
    const old = process.env.BOCHA_API_KEY
    process.env.BOCHA_API_KEY = 'env-sk'
    try {
      const c = resolveWebSearchConfig({ ...base, webSearch: { bocha: { apiKey: 'sk' } } })
      expect(c.bocha).toBe('env-sk')
    } finally { if (old === undefined) delete process.env.BOCHA_API_KEY; else process.env.BOCHA_API_KEY = old }
  })
  it('无配置 → 空对象', () => {
    expect(resolveWebSearchConfig(base)).toEqual({})
  })
})
