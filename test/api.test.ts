import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 隔离真实 provider 配置：mock loadSettings 始终返回默认 deepseek settings（无 provider），
// 使 createClient 对真实 ~/.deepcode/settings.json 中 provider:glm 免疫。
// flag 场景：从 flagPath 文件读取 JSON 并浅合并到默认 settings（baseURL/apiKey 字段透传给客户端）。
vi.mock('../src/config.js', async orig => {
  const actual = await orig() as any
  const { readFileSync } = await import('node:fs')
  return {
    ...actual,
    loadSettings: (_cwd?: string, flagPath?: string) => {
      const base = { permissions: { allow: [] }, costWarnCNY: 15, maxToolResultChars: 100_000 }
      if (!flagPath) return base
      try {
        const raw = JSON.parse(readFileSync(flagPath, 'utf8'))
        return { ...base, ...raw }
      } catch { return base }
    },
  }
})

// createClient 读取 process.env.DEEPSEEK_API_KEY，测试时注入哑值避免抛错
const origKey = process.env.DEEPSEEK_API_KEY
beforeAll(() => { process.env.DEEPSEEK_API_KEY = 'sk-test-dummy' })
afterAll(() => {
  if (origKey === undefined) delete process.env.DEEPSEEK_API_KEY
  else process.env.DEEPSEEK_API_KEY = origKey
})

import { createClient, chatStream } from '../src/api.js'

describe('createClient', () => {
  it('缺省 baseURL 含 api.deepseek.com', () => {
    const c = createClient()
    expect((c as any).baseURL).toContain('api.deepseek.com')
  })

  it('flag 文件的 baseURL 抵达 HTTP 客户端', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-api-test-'))
    const flagFile = join(dir, 'flag.json')
    writeFileSync(flagFile, JSON.stringify({ baseURL: 'https://my-custom-endpoint.example.com/v1' }))
    const c = createClient(flagFile)
    expect((c as any).baseURL).toContain('my-custom-endpoint.example.com')
  })

  it('flag 文件的 apiKey 优先于 env（env 未设时）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-api-test-'))
    const flagFile = join(dir, 'flag.json')
    writeFileSync(flagFile, JSON.stringify({ apiKey: 'sk-flag-key' }))
    // 临时移除 env key，确保 flag apiKey 被用到（不抛 "缺少 API key" 错误）
    const savedKey = process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    try {
      const c = createClient(flagFile)
      expect((c as any).apiKey).toBe('sk-flag-key')
    } finally {
      process.env.DEEPSEEK_API_KEY = savedKey
    }
  })
})

async function captureCreateBody(opts: any): Promise<any> {
  const bodies: any[] = []
  const client: any = {
    chat: { completions: { create: async (body: any) => { bodies.push(body); return (async function* () {})() } } },
  }
  const gen = chatStream(client, { model: 'm', messages: [], tools: [], signal: new AbortController().signal, ...opts })
  let r: any; do { r = await gen.next() } while (!r.done)
  return bodies[0]
}

describe('chatStream effortLevel 透传', () => {
  it('thinking 开 + effortLevel=high → reasoning_effort=high', async () => {
    const body = await captureCreateBody({ thinking: true, effortLevel: 'high' })
    expect(body.reasoning_effort).toBe('high')
    expect(body.thinking).toEqual({ type: 'enabled' })
  })
  it('thinking 开但不传 effortLevel → 默认 medium（向后兼容）', async () => {
    const body = await captureCreateBody({ thinking: true })
    expect(body.reasoning_effort).toBe('medium')
  })
  it('thinking 关 → disabled、无 reasoning_effort', async () => {
    const body = await captureCreateBody({ thinking: false })
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.reasoning_effort).toBeUndefined()
  })
})
