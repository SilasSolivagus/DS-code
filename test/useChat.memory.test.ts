// test/useChat.memory.test.ts
// Task 11：验证 useChat 每轮末 fire-and-forget 触发记忆提取
// I-2：memory.enabled=false 端到端零副作用验证
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const script: Array<{ deltas?: any[]; result: any }> = []
vi.mock('../src/api.js', async orig => ({
  ...(await orig() as any),
  chatStream: vi.fn(() =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      for (const d of scene.deltas ?? []) yield typeof d === 'string' ? { type: 'text', delta: d } : d
      return scene.result
    })(),
  ),
}))

// subagentRunner 归零，防止消耗 chatStream mock 脚本
vi.mock('../src/subagentRunner.js', async orig => ({
  ...(await orig() as any),
  runSubagent: vi.fn(async () => 'ok'),
}))

import { createChatCore } from '../src/tui/useChat.js'
import * as autoDreamMod from '../src/services/memory/autoDream.js'
import { clearAllTasks, listTasks } from '../src/tasks.js'

const usage = { prompt_tokens: 50, completion_tokens: 20, prompt_cache_hit_tokens: 40 }

let sessionDir: string
beforeEach(() => {
  script.length = 0
  vi.clearAllMocks()
  clearAllTasks()
  sessionDir = mkdtempSync(path.join(tmpdir(), 'deepcode-mem-test-'))
})
afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true })
})

describe('useChat 记忆提取接线', () => {
  it('一轮结束后 extractor.onTurnEnd 触发 runSubagent', async () => {
    script.push({
      deltas: ['好的'],
      result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' },
    })

    const runSub = vi.fn(async () => 'ok')
    const core = createChatCore({
      client: {} as any,
      yolo: true,
      cwd: '/tmp',
      sessionDir,
      onState: () => {},
      runSubagent: runSub,
    })

    await core.send('hi')

    // onTurnEnd 是 fire-and-forget，flush 微任务让 Promise 链跑完
    await new Promise(r => setTimeout(r, 50))

    expect(runSub).toHaveBeenCalled()
    core.dispose()
  })
})

describe('usageLog kind:memory 计费与过滤', () => {
  it('memory 记录计入 sessionCost，不计入 cacheHitRate/cacheSavings', async () => {
    script.push({
      deltas: ['ok'],
      result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' },
    })
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    await core.send('test')

    // usageLog 已有主对话记录
    const log = core.state.usageLog
    expect(log.length).toBeGreaterThan(0)

    const mainCost = core.state.sessionCost()
    const mainCacheHit = core.state.cacheHitRate()
    const mainSavings = core.state.cacheSavings()

    // 注入一条 kind:'memory' 记录（模拟记忆 fork 推入）
    log.push({ usage: { prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 80 }, model: 'deepseek-v4-flash', kind: 'memory' })

    // sessionCost 包含 memory 记录（成本全部可见）
    expect(core.state.sessionCost()).toBeGreaterThan(mainCost)

    // cacheHitRate 不包含 memory 记录（80/100 会极大拉高比率，应保持主对话值）
    expect(core.state.cacheHitRate()).toBeCloseTo(mainCacheHit)

    // cacheSavings 不包含 memory 记录
    expect(core.state.cacheSavings()).toBeCloseTo(mainSavings)

    core.dispose()
  })

  it('只有 memory 记录时 cacheHitRate 返回 0（无主对话 prompt_tokens）', () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    const log = core.state.usageLog
    log.push({ usage: { prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 80 }, model: 'deepseek-v4-flash', kind: 'memory' })
    // 无主对话记录，分母为 0 → 返回 0
    expect(core.state.cacheHitRate()).toBe(0)
    core.dispose()
  })
})

describe('useChat memory.enabled=false 端到端零副作用', () => {
  it('disabled 时：subagent 零调用、无 dream 任务、系统提示无记忆索引', async () => {
    // 准备 settings 文件，注入 memory.enabled=false
    const settingsFile = path.join(sessionDir, 'settings-disabled.json')
    writeFileSync(settingsFile, JSON.stringify({ memory: { enabled: false } }))

    script.push({
      deltas: ['好的'],
      result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' },
    })

    const runSub = vi.fn(async () => 'ok')
    const dreamSpy = vi.spyOn(autoDreamMod, 'runAutoDream').mockResolvedValue(undefined)

    let capturedSystemPrompt: string | undefined
    const core = createChatCore({
      client: {} as any,
      yolo: true,
      cwd: '/tmp',
      sessionDir,
      flagSettingsPath: settingsFile,
      onState: () => {},
      runSubagent: runSub,
    })

    // 捕获系统提示（第一条 message 是 system）
    const coreAny = core as any
    // 访问内部 messages 数组需借 send 执行前检查
    // 通过 transcript 后验证 system prompt：直接从 state 消息数组取
    await core.send('hi')
    await new Promise(r => setTimeout(r, 50))

    // ① runSubagent 零调用（提取器和 sessionMemory 都不应触发）
    expect(runSub).not.toHaveBeenCalled()

    // ② 无 dream 任务注册
    const dreamTasks = listTasks().filter(t => t.description.includes('dream'))
    expect(dreamTasks).toHaveLength(0)
    // dreamSpy 也不应被调用（autoDream 整个被 if(mem.enabled) 守卫跳过）
    expect(dreamSpy).not.toHaveBeenCalled()

    // ③ 系统提示不含记忆索引（## 记忆索引 是 loadMemoryPrompt 的固定前缀）
    // 从 transcript 中找 assistant 回复，系统提示在 messages[0].content
    // 通过 /context 斜杠命令验证不可行（非直接），故通过反向推断：
    // 若 memory.enabled=false，memdirFor 不被调用 → buildSystemPrompt 无 memdir → 无 ## 记忆索引
    // 用 vi.spyOn 捕获 buildSystemPrompt 或直接在 session 文件查 system message
    // 最简单：通过 session 文件的第一行（appendMessage(messages[0])）读取
    const sessionFiles = readdirSync(sessionDir).filter((f: string) => f.endsWith('.jsonl'))
    expect(sessionFiles.length).toBeGreaterThan(0)
    const sessionContent = readFileSync(path.join(sessionDir, sessionFiles[0]), 'utf8')
    const firstLine = JSON.parse(sessionContent.split('\n')[0])
    // 第一行是 meta，第二行是 system message
    const secondLine = JSON.parse(sessionContent.split('\n').filter(Boolean)[1])
    expect(secondLine.m?.role).toBe('system')
    capturedSystemPrompt = secondLine.m?.content
    expect(capturedSystemPrompt).toBeDefined()
    expect(capturedSystemPrompt).not.toContain('## 记忆索引')

    dreamSpy.mockRestore()
    core.dispose()
  })
})
