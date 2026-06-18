import { describe, it, expect } from 'vitest'
import { bochaSearch, tavilySearch, normalizeUrl, mergeResults } from '../src/webSearch.js'

describe('bochaSearch', () => {
  it('解析 data.webPages.value[]，name→title，url 空跳过', async () => {
    const captured: any = {}
    const fetchJson = async (url: string, init: any) => {
      captured.url = url; captured.body = JSON.parse(init.body); captured.auth = init.headers['Authorization']
      return { data: { webPages: { value: [
        { name: '标题A', url: 'https://a.com', snippet: '摘要A' },
        { name: '无url', url: '', snippet: 'x' },
      ] } } }
    }
    const r = await bochaSearch('sk-key', '查询', { count: 5 }, fetchJson)
    expect(captured.url).toBe('https://api.bochaai.com/v1/web-search')
    expect(captured.auth).toBe('Bearer sk-key')
    expect(captured.body).toMatchObject({ query: '查询', count: 5, freshness: 'noLimit' })
    expect(r).toEqual([{ title: '标题A', url: 'https://a.com', snippet: '摘要A' }])
  })
  it('非 2xx（fetchJson 抛）冒泡', async () => {
    const fetchJson = async () => { throw new Error('HTTP 401') }
    await expect(bochaSearch('sk', 'q', {}, fetchJson)).rejects.toThrow('HTTP 401')
  })
})

describe('tavilySearch', () => {
  it('解析 results[]，content→snippet，域名入 body', async () => {
    const captured: any = {}
    const fetchJson = async (url: string, init: any) => {
      captured.url = url; captured.body = JSON.parse(init.body)
      return { results: [{ title: 'T', url: 'https://t.com', content: '正文摘要', score: 0.9 }] }
    }
    const r = await tavilySearch('tvly-k', 'q', { count: 5, allowedDomains: ['t.com'] }, fetchJson)
    expect(captured.url).toBe('https://api.tavily.com/search')
    expect(captured.body).toMatchObject({ query: 'q', max_results: 5, include_domains: ['t.com'] })
    expect(r).toEqual([{ title: 'T', url: 'https://t.com', snippet: '正文摘要' }])
  })
  it('blocked_domains 入 exclude_domains', async () => {
    const captured: any = {}
    const fetchJson = async (_u: string, init: any) => { captured.body = JSON.parse(init.body); return { results: [] } }
    await tavilySearch('k', 'q', { blockedDomains: ['bad.com'] }, fetchJson)
    expect(captured.body.exclude_domains).toEqual(['bad.com'])
    expect(captured.body.include_domains).toBeUndefined()
  })
})

describe('normalizeUrl', () => {
  it('host 小写 + 去 fragment + 去尾斜杠', () => {
    expect(normalizeUrl('https://Example.com/Path/#frag')).toBe('https://example.com/Path')
    expect(normalizeUrl('https://a.com/')).toBe('https://a.com')
  })
  it('非法 URL 返回原串', () => {
    expect(normalizeUrl('not a url')).toBe('not a url')
  })
})

describe('mergeResults', () => {
  const mk = (u: string, t = 't', s = 's') => ({ title: t, url: u, snippet: s })
  it('round-robin 交错 + URL 去重（首次胜）', () => {
    const a = [mk('https://a.com'), mk('https://b.com')]
    const b = [mk('https://b.com/'), mk('https://c.com')]   // b.com/ 归一后撞 a 的 b.com
    const r = mergeResults([a, b])
    expect(r.map(x => x.url)).toEqual(['https://a.com', 'https://b.com/', 'https://c.com'])
    // 注：round-robin 序 a[0],b[0],a[1](dup 跳),b[1] → a.com, b.com/, (b.com dup), c.com
  })
  it('截到 cap', () => {
    const list = Array.from({ length: 12 }, (_, i) => mk(`https://x${i}.com`))
    expect(mergeResults([list], 8)).toHaveLength(8)
  })
  it('snippet 截 200 字加 …', () => {
    const long = 'x'.repeat(300)
    const r = mergeResults([[mk('https://a.com', 't', long)]])
    expect(r[0].snippet).toBe('x'.repeat(200) + '…')
  })
})
