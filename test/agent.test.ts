import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

import { makeAgentTool } from '../src/tools/agent.js'

const usage = { prompt_tokens: 30, completion_tokens: 10, prompt_cache_hit_tokens: 0 }
const ctx = (): any => ({
  cwd: () => process.cwd(), setCwd: () => {}, signal: new AbortController().signal, fileState: new Map(),
})
beforeEach(() => { script.length = 0; vi.clearAllMocks() })

describe('Agent 子代理', () => {
  it('递归跑 runLoop，返回子代理最终文本，usage 上报', async () => {
    script.push(
      {
        result: {
          content: '', toolCalls: [{ id: 's1', name: 'Glob', args: '{"pattern":"src/*.ts"}' }],
          usage, finishReason: 'tool_calls',
        },
      },
      { result: { content: '共 17 个 TS 文件，入口是 src/index.ts', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const reported: any[] = []
    const tool = makeAgentTool({ client: {} as any, onUsage: (u, m) => reported.push([u, m]) })
    const out = await tool.call({ description: '数文件', prompt: '统计 src 下 TS 文件数量' }, ctx())
    expect(out).toContain('17 个')
    expect(reported.length).toBe(2) // 两轮各上报一次
    expect(reported[0][1]).toBe('deepseek-v4-flash')
  })

  it('子代理只有只读工具，使用独立 fileState', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-agent-'))
    const tmpFile = path.join(dir, 'probe.txt')
    writeFileSync(tmpFile, 'probe content')
    // 第一幕：子代理调用 Read 读取文件
    script.push(
      {
        result: {
          content: '',
          toolCalls: [{ id: 'r1', name: 'Read', args: JSON.stringify({ file_path: tmpFile }) }],
          usage,
          finishReason: 'tool_calls',
        },
      },
      // 第二幕：子代理结束
      { result: { content: '结论', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {} })
    const c = ctx()
    await tool.call({ description: 'x', prompt: 'y' }, c)
    const { chatStream } = await import('../src/api.js')
    // call[0] = 第一幕（子代理发起），call[1] = 第二幕（带 tool 结果）
    const sentTools = (chatStream as any).mock.calls[0][1].tools.map((t: any) => t.function.name)
    expect(sentTools.sort()).toEqual(['Glob', 'Grep', 'Read'])
    // 第二幕的 messages 应包含 Read 的 tool 结果（含文件内容），确保 Read 真正执行了
    const secondCallMessages: any[] = (chatStream as any).mock.calls[1][1].messages
    const toolResultMsg = secondCallMessages.find((m: any) => m.role === 'tool')
    expect(toolResultMsg).toBeDefined()
    expect(toolResultMsg.content).toContain('probe content')
    // 子代理读了文件，但主 ctx 的 fileState 不应被污染
    expect(c.fileState.size).toBe(0)
  })

  it('子代理无文本输出时返回兜底文案', async () => {
    script.push({ result: { content: '', toolCalls: [], usage, finishReason: 'stop' } })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {} })
    const out = await tool.call({ description: 'x', prompt: 'y' }, ctx())
    expect(out).toContain('无输出')
  })

  it('子代理抛错时 call 拒绝，且信号量槽位已释放（第二次调用仍成功）', async () => {
    // 脚本为空 → chatStream 抛 'script exhausted' → sub-loop 异常
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {} })
    await expect(tool.call({ description: 'err', prompt: 'boom' }, ctx())).rejects.toThrow('script exhausted')

    // 第二次调用要能拿到信号量并正常返回，证明 finally 的 release 执行了
    script.push({ result: { content: '正常结果', toolCalls: [], usage, finishReason: 'stop' } })
    const out = await tool.call({ description: 'ok', prompt: 'ok' }, ctx())
    expect(out).toContain('正常结果')
  })
})
