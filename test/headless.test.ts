// test/headless.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'

const script: Array<{ deltas?: any[]; result: any }> = []
vi.mock('../src/api.js', () => ({
  chatStream: vi.fn(() =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      for (const d of scene.deltas ?? []) yield typeof d === 'string' ? { type: 'text', delta: d } : d
      return scene.result
    })(),
  ),
}))

const hookCalls: Array<{ event: string; payload: any }> = []
vi.mock('../src/hooks.js', async (orig) => {
  const actual = await orig<typeof import('../src/hooks.js')>()
  return {
    ...actual,
    runHooks: vi.fn(async (event: any, payload: any) => {
      hookCalls.push({ event, payload })
      return { block: false, preventContinuation: false, stop: false, results: [] }
    }),
  }
})

vi.mock('../src/config.js', async (orig) => {
  const actual = await orig<typeof import('../src/config.js')>()
  return {
    ...actual,
    loadSettings: vi.fn(() => ({
      permissions: { allow: [] },
      compactTokens: 200_000,
      costWarnUSD: 2,
      hooks: {
        SessionStart: [{ matcher: '*', hooks: [] }],
        InstructionsLoaded: [{ matcher: '*', hooks: [] }],
        UserPromptSubmit: [{ matcher: '*', hooks: [] }],
      },
    })),
  }
})

import { runHeadless } from '../src/headless.js'
import { chatStream } from '../src/api.js'
import { runHooks } from '../src/hooks.js'

const usage = { prompt_tokens: 50, completion_tokens: 20, prompt_cache_hit_tokens: 10 }
beforeEach(() => { script.length = 0; hookCalls.length = 0; vi.mocked(chatStream).mockClear() })

describe('runHeadless', () => {
  it('跑完单 prompt 返回最终文本与累计 usage/cost/轮数', async () => {
    script.push(
      {
        result: {
          content: '', toolCalls: [{ id: 'h1', name: 'Glob', args: '{"pattern":"*.md"}' }],
          usage, finishReason: 'tool_calls',
        },
      },
      { result: { content: '找到 1 个 md 文件', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const r = await runHeadless({ client: {} as any, prompt: '有几个 md？', yolo: true })
    expect(r.text).toContain('1 个')
    expect(r.usage.prompt_tokens).toBe(100) // 两轮累计
    expect(r.usage.completion_tokens).toBe(40)
    expect(r.costUSD).toBeGreaterThan(0)
    expect(r.turns).toBe(2)
    expect(r.status).toBe('done')
  })

  it('非 yolo 时权限询问自动拒绝（headless 无人值守）', async () => {
    script.push(
      {
        result: {
          content: '', toolCalls: [{ id: 'h2', name: 'Bash', args: '{"command":"touch /tmp/x"}' }],
          usage, finishReason: 'tool_calls',
        },
      },
      { result: { content: '被拒了', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const r = await runHeadless({ client: {} as any, prompt: '建个文件', yolo: false })
    expect(r.status).toBe('done') // 不挂起、不抛错，拒绝理由按正常机制喂回模型
  })

  it('todo 过期时在工具消息中注入 system-reminder', async () => {
    // Turn 1: TodoWrite 设置清单（in_progress 条目），lastUpdateTurn=0，tick→currentTurn=1，delta=1
    // Turn 2: Glob，tick→currentTurn=2，delta=2，无提醒
    // Turn 3: Glob，tick→currentTurn=3，delta=3，提醒触发
    // Turn 4: Glob，tick→currentTurn=4，delta=4（4%3≠0），无提醒
    // Turn 5: stop
    script.push(
      {
        result: {
          content: '',
          toolCalls: [{ id: 'tw1', name: 'TodoWrite', args: JSON.stringify({ todos: [{ content: '修 bug', status: 'in_progress' }] }) }],
          usage, finishReason: 'tool_calls',
        },
      },
      {
        result: {
          content: '',
          toolCalls: [{ id: 'g1', name: 'Glob', args: '{"pattern":"*"}' }],
          usage, finishReason: 'tool_calls',
        },
      },
      {
        result: {
          content: '',
          toolCalls: [{ id: 'g2', name: 'Glob', args: '{"pattern":"*"}' }],
          usage, finishReason: 'tool_calls',
        },
      },
      {
        result: {
          content: '',
          toolCalls: [{ id: 'g3', name: 'Glob', args: '{"pattern":"*"}' }],
          usage, finishReason: 'tool_calls',
        },
      },
      { result: { content: '完成', toolCalls: [], usage, finishReason: 'stop' } },
    )
    await runHeadless({ client: {} as any, prompt: '做任务', yolo: true })
    // 找到最终一次 chatStream 调用，检查其 messages 参数中是否有包含 <system-reminder> + '修 bug' 的 tool 消息
    const allCalls = vi.mocked(chatStream).mock.calls
    const allMessages: any[] = allCalls.flatMap(([_client, opts]) => opts.messages ?? [])
    const reminderMsg = allMessages.find(
      m => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('<system-reminder>') && m.content.includes('修 bug'),
    )
    expect(reminderMsg).toBeDefined()
  })

  it('headless 工具表不注册 AskUserQuestion（无人可答）', () => {
    const src = readFileSync(new URL('../src/headless.ts', import.meta.url), 'utf8')
    expect(src.includes('makeAskUserQuestionTool')).toBe(false)
  })

  it('UserPromptSubmit block 时拦截文本同时带上 blockReason 与 additionalContext', async () => {
    vi.mocked(runHooks).mockImplementation(async (event: any, payload: any) => {
      hookCalls.push({ event, payload })
      // 仅 UserPromptSubmit 返回 block + additionalContext，其余事件走默认放行
      if (event === 'UserPromptSubmit') {
        return { block: true, preventContinuation: false, stop: false, blockReason: '拒', additionalContext: '附加上下文', results: [] } as any
      }
      return { block: false, preventContinuation: false, stop: false, results: [] } as any
    })
    try {
      const r = await runHeadless({ client: {} as any, prompt: '坏输入', yolo: true })
      expect(r.status).toBe('aborted')
      expect(r.text).toContain('拒')
      expect(r.text).toContain('附加上下文')
    } finally {
      // mockImplementation 持久，恢复默认放行实现避免污染后续用例
      vi.mocked(runHooks).mockImplementation(async (event: any, payload: any) => {
        hookCalls.push({ event, payload })
        return { block: false, preventContinuation: false, stop: false, results: [] } as any
      })
    }
  })

  it('启动派发 SessionStart(startup) 与 InstructionsLoaded', async () => {
    hookCalls.length = 0
    const memPath = path.join(process.cwd(), 'DEEPCODE.md')
    const createdMem = !existsSync(memPath)
    if (createdMem) writeFileSync(memPath, '# headless 测试记忆')
    try {
      script.push({ result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
      await runHeadless({ client: {} as any, prompt: '你好', yolo: true })
      const ss = hookCalls.find(c => c.event === 'SessionStart')
      expect(ss?.payload.source).toBe('startup')
      expect(ss?.payload.session_id).toMatch(/^headless-/)
      const il = hookCalls.find(c => c.event === 'InstructionsLoaded' && c.payload.load_reason === 'startup')
      expect(il).toBeTruthy()
      expect(il!.payload.file_path).toContain('DEEPCODE.md')
    } finally {
      if (createdMem) rmSync(memPath, { force: true })
    }
  })
})
