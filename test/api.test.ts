import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

// createClient 读取 process.env.DEEPSEEK_API_KEY，测试时注入哑值避免抛错
const origKey = process.env.DEEPSEEK_API_KEY
beforeAll(() => { process.env.DEEPSEEK_API_KEY = 'sk-test-dummy' })
afterAll(() => {
  if (origKey === undefined) delete process.env.DEEPSEEK_API_KEY
  else process.env.DEEPSEEK_API_KEY = origKey
})

// loadSettings 读取 ~/.deepcode/settings.json；测试只锁"缺省 baseURL = api.deepseek.com"，
// 不注入文件（避免污染真实 HOME）。若机器恰好有本地 settings.json 且写了 baseURL，
// 该测试在 CI 会绕过（接受：plan 明确说只锁缺省值）。
import { createClient, chatStream } from '../src/api.js'

describe('createClient', () => {
  it('缺省 baseURL 含 api.deepseek.com', () => {
    const c = createClient()
    expect((c as any).baseURL).toContain('api.deepseek.com')
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
