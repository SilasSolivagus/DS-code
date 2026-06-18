// test/hooks.http.test.ts
import { describe, it, expect, vi } from 'vitest'
import { urlMatchesPattern, runHooks } from '../src/hooks.js'
import type { HooksConfig } from '../src/hooks.js'

describe('urlMatchesPattern', () => {
  it('* 通配 + 正则元字符转义', () => {
    expect(urlMatchesPattern('https://hooks.example.com/x', 'https://hooks.example.com/*')).toBe(true)
    expect(urlMatchesPattern('https://evil.com/x', 'https://hooks.example.com/*')).toBe(false)
    expect(urlMatchesPattern('https://a.b.com', 'https://*.b.com')).toBe(true)
    expect(urlMatchesPattern('https://a.bXcom', 'https://a.b.com')).toBe(false) // . 不当通配
  })

  it('精确匹配（无通配）', () => {
    expect(urlMatchesPattern('https://example.com/hook', 'https://example.com/hook')).toBe(true)
    expect(urlMatchesPattern('https://example.com/hook2', 'https://example.com/hook')).toBe(false)
  })

  it('* 匹配路径段', () => {
    expect(urlMatchesPattern('https://api.example.com/v1/events', 'https://api.example.com/*/events')).toBe(true)
    expect(urlMatchesPattern('https://api.example.com/v2/events', 'https://api.example.com/*/events')).toBe(true)
    expect(urlMatchesPattern('https://api.example.com/v1/other', 'https://api.example.com/*/events')).toBe(false)
  })
})

describe('execHttpHook URL allowlist', () => {
  it('allowedHttpHookUrls 不含该 url → fetch 未被调用，结果 outcome=blocking', async () => {
    const mockFetch = vi.fn()
    const config: HooksConfig = {
      PreToolUse: [{
        hooks: [{ type: 'http', url: 'https://evil.com/hook' }],
      }],
    }
    const result = await runHooks('PreToolUse', { tool_name: 'Write' }, config, {
      fetch: mockFetch as any,
      allowedHttpHookUrls: ['https://hooks.example.com/*'],
    })
    expect(mockFetch).not.toHaveBeenCalled()
    expect(result.block).toBe(true)
    expect(result.results[0]?.outcome).toBe('blocking')
  })

  it('allowedHttpHookUrls=undefined → 不限制，fetch 被调用', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => '',
    })
    const config: HooksConfig = {
      PreToolUse: [{
        hooks: [{ type: 'http', url: 'https://anywhere.com/hook' }],
      }],
    }
    await runHooks('PreToolUse', { tool_name: 'Write' }, config, {
      fetch: mockFetch as any,
      allowedHttpHookUrls: undefined,
    })
    expect(mockFetch).toHaveBeenCalledOnce()
  })

  it('allowedHttpHookUrls=[] → 全禁，fetch 未被调用', async () => {
    const mockFetch = vi.fn()
    const config: HooksConfig = {
      PreToolUse: [{
        hooks: [{ type: 'http', url: 'https://example.com/hook' }],
      }],
    }
    const result = await runHooks('PreToolUse', { tool_name: 'Write' }, config, {
      fetch: mockFetch as any,
      allowedHttpHookUrls: [],
    })
    expect(mockFetch).not.toHaveBeenCalled()
    expect(result.block).toBe(true)
  })

  it('url 匹配 allowedHttpHookUrls 白名单 → fetch 被调用', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => '',
    })
    const config: HooksConfig = {
      PreToolUse: [{
        hooks: [{ type: 'http', url: 'https://hooks.example.com/events' }],
      }],
    }
    await runHooks('PreToolUse', { tool_name: 'Write' }, config, {
      fetch: mockFetch as any,
      allowedHttpHookUrls: ['https://hooks.example.com/*'],
    })
    expect(mockFetch).toHaveBeenCalledOnce()
  })
})

describe('execHttpHook env var intersection', () => {
  it('httpHookAllowedEnvVars=[A] + hook.allowedEnvVars=[A,B] → 只有 A 被插值，B 变空', async () => {
    process.env._DEEPCODE_TEST_A = 'value_a'
    process.env._DEEPCODE_TEST_B = 'value_b'

    let capturedHeaders: Record<string, string> | undefined

    const mockFetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedHeaders = opts?.headers
      return { status: 200, text: async () => '' }
    })

    const config: HooksConfig = {
      PreToolUse: [{
        hooks: [{
          type: 'http',
          url: 'https://hooks.example.com/hook',
          allowedEnvVars: ['_DEEPCODE_TEST_A', '_DEEPCODE_TEST_B'],
          headers: {
            'X-Token-A': '${_DEEPCODE_TEST_A}',
            'X-Token-B': '${_DEEPCODE_TEST_B}',
          },
        }],
      }],
    }

    await runHooks('PreToolUse', { tool_name: 'Write' }, config, {
      fetch: mockFetch as any,
      allowedHttpHookUrls: ['https://hooks.example.com/*'],
      httpHookAllowedEnvVars: ['_DEEPCODE_TEST_A'], // only A allowed at policy level
    })

    delete process.env._DEEPCODE_TEST_A
    delete process.env._DEEPCODE_TEST_B

    expect(capturedHeaders?.['X-Token-A']).toBe('value_a')
    expect(capturedHeaders?.['X-Token-B']).toBe('') // B stripped by intersection
  })

  it('httpHookAllowedEnvVars=undefined → 不交集，hook 自身 allowedEnvVars 全可用', async () => {
    process.env._DEEPCODE_TEST_C = 'value_c'

    let capturedHeaders: Record<string, string> | undefined

    const mockFetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedHeaders = opts?.headers
      return { status: 200, text: async () => '' }
    })

    const config: HooksConfig = {
      PreToolUse: [{
        hooks: [{
          type: 'http',
          url: 'https://hooks.example.com/hook',
          allowedEnvVars: ['_DEEPCODE_TEST_C'],
          headers: { 'X-Token-C': '${_DEEPCODE_TEST_C}' },
        }],
      }],
    }

    await runHooks('PreToolUse', { tool_name: 'Write' }, config, {
      fetch: mockFetch as any,
      allowedHttpHookUrls: undefined,
      httpHookAllowedEnvVars: undefined,
    })

    delete process.env._DEEPCODE_TEST_C

    expect(capturedHeaders?.['X-Token-C']).toBe('value_c')
  })
})

describe('execHttpHook redirect:error', () => {
  it('fetch 调用时传入 redirect:error', async () => {
    let capturedOpts: any

    const mockFetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedOpts = opts
      return { status: 200, text: async () => '' }
    })

    const config: HooksConfig = {
      PreToolUse: [{
        hooks: [{ type: 'http', url: 'https://hooks.example.com/hook' }],
      }],
    }

    await runHooks('PreToolUse', { tool_name: 'Write' }, config, {
      fetch: mockFetch as any,
    })

    expect(capturedOpts?.redirect).toBe('error')
  })
})
