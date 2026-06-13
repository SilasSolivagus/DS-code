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
import { createClient } from '../src/api.js'

describe('createClient', () => {
  it('缺省 baseURL 含 api.deepseek.com', () => {
    const c = createClient()
    expect((c as any).baseURL).toContain('api.deepseek.com')
  })
})
