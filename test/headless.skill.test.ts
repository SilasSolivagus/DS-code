// test/headless.skill.test.ts —— 验证 headless 的 Skills 接线：
// Skill 工具进工具池、模型调用后注入 inline 正文以 user 消息出现在 messages 中。

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- api mock（与 headless.mcp.test.ts 相同模式）----
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

vi.mock('../src/hooks.js', async (orig) => {
  const actual = await orig<typeof import('../src/hooks.js')>()
  return {
    ...actual,
    runHooks: vi.fn(async () => ({ block: false, preventContinuation: false, stop: false, results: [] })),
  }
})

vi.mock('../src/config.js', async (orig) => {
  const actual = await orig<typeof import('../src/config.js')>()
  return {
    ...actual,
    loadSettings: vi.fn(() => ({
      permissions: { allow: [] },
      compactTokens: 200_000,
      costWarnCNY: 2,
    })),
  }
})

// ---- skillsLoader mock：注入一个受控 inline skill ----
const fakeSkill = {
  name: 'test-skill',
  description: '测试用 inline skill',
  context: 'inline' as const,
  userInvocable: true,
  modelInvocable: true,
  skillDir: '/fake/skills/test-skill',
  isLegacy: false,
  priority: 0,
  body: '请按此指令执行：$ARGUMENTS',
}

vi.mock('../src/skillsLoader.js', async (orig) => {
  const actual = await orig<typeof import('../src/skillsLoader.js')>()
  return {
    ...actual,
    // 保留 substituteSkillArgs 原实现（Skill 工具依赖），只替换 loadSkills
    substituteSkillArgs: actual.substituteSkillArgs,
    loadSkills: vi.fn(() => [fakeSkill]),
  }
})

import { runHeadless } from '../src/headless.js'
import { chatStream } from '../src/api.js'
import { loadSkills } from '../src/skillsLoader.js'
import { loadSettings } from '../src/config.js'

const usage = { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0 }

beforeEach(() => {
  script.length = 0
  vi.mocked(chatStream).mockClear()
  vi.mocked(loadSkills).mockReset()
  vi.mocked(loadSkills).mockImplementation(() => [fakeSkill])
})

describe('headless Skills 接线', () => {
  it('Skill 工具在工具池中（第一轮 chatStream 调用的 tools 包含 Skill）', async () => {
    script.push({ result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
    await runHeadless({ client: {} as any, prompt: '你好', yolo: true })

    const firstCall = vi.mocked(chatStream).mock.calls[0]
    const tools = firstCall[1].tools as any[]
    expect(tools).toBeDefined()
    const skillTool = tools.find((t: any) => t.name === 'Skill' || t.function?.name === 'Skill')
    expect(skillTool).toBeDefined()
  })

  it('settings.skills.deny 排除的 skill 不出现在 system prompt', async () => {
    // 准备两个 skill：keep（保留）、drop（被 deny 排除）
    const keepSkill = { ...fakeSkill, name: 'keep', description: '保留的 skill', modelInvocable: true }
    const dropSkill = { ...fakeSkill, name: 'drop', description: '被排除的 skill', modelInvocable: true }

    // loadSettings mock 返回 skills.deny=['drop']
    vi.mocked(loadSettings).mockReturnValueOnce({
      permissions: { allow: [] },
      compactTokens: 200_000,
      costWarnCNY: 2,
      maxToolResultChars: 100_000,
      skills: { deny: ['drop'] },
    })

    // loadSkills mock：按 config.deny 过滤（模拟真实 loadSkills 的 deny 逻辑）
    vi.mocked(loadSkills).mockImplementationOnce((_cwd, _home, config) => {
      const all = [keepSkill, dropSkill]
      if (!config?.deny?.length) return all
      const deny = new Set(config.deny)
      return all.filter(s => !deny.has(s.name))
    })

    script.push({ result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
    await runHeadless({ client: {} as any, prompt: '你好', yolo: true })

    // 第一轮 chatStream 的 system message 应含 'keep'，不含 'drop'
    const firstCall = vi.mocked(chatStream).mock.calls[0]
    const messages = firstCall[1].messages as any[]
    const systemMsg = messages.find((m: any) => m.role === 'system')
    expect(systemMsg).toBeDefined()
    expect(systemMsg.content).toContain('keep')
    expect(systemMsg.content).not.toContain('drop')
  })

  it('模型调用 Skill → inline 注入 → 正文以 user 消息出现在第二轮 messages 中', async () => {
    // 第一轮：模型调用 Skill("test-skill", "hello")
    script.push({
      result: {
        content: '',
        toolCalls: [{ id: 's1', name: 'Skill', args: JSON.stringify({ skill: 'test-skill', args: 'hello' }) }],
        usage,
        finishReason: 'tool_calls',
      },
    })
    // 第二轮：模型读到注入的 user 消息后作答
    script.push({
      result: { content: '已按 skill 指令执行', toolCalls: [], usage, finishReason: 'stop' },
    })

    await runHeadless({ client: {} as any, prompt: '执行 skill', yolo: true })

    // 检查第二轮 chatStream 调用的 messages：应含 role:'user' 且 content 为替换后正文
    const calls = vi.mocked(chatStream).mock.calls
    expect(calls.length).toBeGreaterThanOrEqual(2)
    const secondCallMsgs: any[] = calls[1][1].messages
    const injectedMsg = secondCallMsgs.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('请按此指令执行：hello'),
    )
    expect(injectedMsg).toBeDefined()
  })
})
