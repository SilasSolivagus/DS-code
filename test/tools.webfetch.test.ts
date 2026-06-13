import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchMock = vi.fn()
vi.mock('undici', () => ({
  fetch: (...a: any[]) => fetchMock(...a),
  ProxyAgent: class { constructor(_: string) {} },
}))

let lastMessages: any[] = []
vi.mock('../src/loop.js', () => ({
  runLoop: async function* (messages: any[]) {
    lastMessages = messages
    messages.push({ role: 'assistant', content: 'MOCK 答案' })
    yield { type: 'turn_end', usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0 } }
  },
}))

import { makeWebFetchTool } from '../src/tools/webfetch.js'

const ctx: any = { cwd: () => '/tmp', setCwd: () => {}, signal: new AbortController().signal, fileState: new Map() }
const onUsage = vi.fn()
const tool = makeWebFetchTool({ client: {} as any, onUsage })

function resp(body: string, ct = 'text/html', ok = true, status = 200) {
  return { ok, status, statusText: ok ? 'OK' : 'ERR', headers: { get: () => ct }, text: async () => body }
}

describe('WebFetch', () => {
  beforeEach(() => { fetchMock.mockReset(); onUsage.mockClear(); lastMessages = [] })

  it('权限：返回 host 描述', () => {
    expect(tool.needsPermission({ url: 'https://example.com/x', prompt: 'q' })).toContain('example.com')
    expect(tool.isReadOnly).toBe(false)
  })

  it('抓取 HTML→剥标签→子模型作答，content 进 user 消息', async () => {
    fetchMock.mockResolvedValue(resp('<html><body><script>x</script><h1>标题</h1>正文</body></html>'))
    const out = await tool.call({ url: 'https://example.com', prompt: '讲了啥' }, ctx)
    expect(out).toBe('MOCK 答案')
    const user = lastMessages.find(m => m.role === 'user')!
    expect(user.content).toContain('标题')
    expect(user.content).toContain('正文')
    expect(user.content).not.toContain('<script>')
    expect(user.content).toContain('讲了啥')
    expect(onUsage).toHaveBeenCalled()
  })

  it('非 http(s) 拒绝', async () => {
    const out = await tool.call({ url: 'ftp://x', prompt: 'q' } as any, ctx)
    expect(out).toContain('仅支持 http')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('非 200 返回错误', async () => {
    fetchMock.mockResolvedValue(resp('', 'text/html', false, 404))
    const out = await tool.call({ url: 'https://example.com', prompt: 'q' }, ctx)
    expect(out).toContain('404')
  })

  it('超长内容截断到 30k 并标注', async () => {
    fetchMock.mockResolvedValue(resp('a'.repeat(40_000), 'text/plain'))
    await tool.call({ url: 'https://example.com', prompt: 'q' }, ctx)
    const user = lastMessages.find(m => m.role === 'user')!
    expect(user.content).toContain('内容已截断')
    // 正文被截到 ~30k（未截则约 40k）；用长度上界判断，避免数 URL 里的字符
    expect(user.content.length).toBeLessThan(31_000)
  })
})
