// test/useChat.autoDream.test.ts
// Task 20：验证 useChat 每轮末 fire-and-forget 触发 autoDream（满门控时）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
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
import { clearAllTasks, drainNotifications, listTasks } from '../src/tasks.js'

const usage = { prompt_tokens: 50, completion_tokens: 20, prompt_cache_hit_tokens: 0 }

let sessionDir: string
beforeEach(() => {
  script.length = 0
  vi.clearAllMocks()
  clearAllTasks()
  drainNotifications() // 清空模块级通知队列，防止跨测试泄漏
  sessionDir = mkdtempSync(path.join(tmpdir(), 'deepcode-dream-test-'))
})
afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true })
})

describe('useChat autoDream 接线', () => {
  it('dream.enabled=true（默认）时，每轮末调用 runAutoDream', async () => {
    script.push({
      deltas: ['好的'],
      result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' },
    })

    const dreamSpy = vi.spyOn(autoDreamMod, 'runAutoDream').mockResolvedValue(undefined)

    const core = createChatCore({
      client: {} as any,
      yolo: true,
      cwd: '/tmp',
      sessionDir,
      onState: () => {},
    })

    await core.send('hello')
    await new Promise(r => setTimeout(r, 50))

    expect(dreamSpy).toHaveBeenCalledTimes(1)
    const callArg = dreamSpy.mock.calls[0][0]
    expect(callArg.cfg).toBeDefined()
    expect(typeof callArg.onStart).toBe('function')
    expect(typeof callArg.onDone).toBe('function')
    expect(callArg.sessionsDir).toContain('.deepcode')
    expect(callArg.sessionsDir).toContain('sessions')
    expect(typeof callArg.projectKey).toBe('string')
    expect(callArg.projectKey.length).toBeGreaterThan(0)

    dreamSpy.mockRestore()
    core.dispose()
  })

  it('onStart 触发时注册任务，onDone(true) 时任务标为 completed', async () => {
    // 第一轮：用户输入
    script.push({
      deltas: ['好的'],
      result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' },
    })
    // 第二轮：onDone(true) 入队通知 → wakeOnNotification 触发空闲唤醒轮
    script.push({
      deltas: ['收到'],
      result: { content: '收到', toolCalls: [], usage, finishReason: 'stop' },
    })

    // 模拟 runAutoDream 实际触发回调（门控过、取锁成功）。
    // 仅首次触发 onStart/onDone；后续（wakeOnNotification 轮）静默返回，防止无限递归。
    const dreamSpy = vi.spyOn(autoDreamMod, 'runAutoDream')
      .mockImplementationOnce(async (deps) => {
        deps.onStart?.()
        deps.onDone?.(true)
      })
      .mockResolvedValue(undefined)

    const core = createChatCore({
      client: {} as any,
      yolo: true,
      cwd: '/tmp',
      sessionDir,
      onState: () => {},
    })

    await core.send('hello')
    // 等待 wakeOnNotification 触发的轮次完成
    await vi.waitFor(() => expect(core.state.busy).toBe(false), { timeout: 2000 })

    // 任务状态应为 completed
    const tasks = listTasks()
    const dreamTask = tasks.find(t => t.description.includes('dream'))
    expect(dreamTask).toBeDefined()
    expect(dreamTask?.status).toBe('completed')
    // wakeOnNotification 触发了第二轮（transcript 含唤醒 user 块）
    expect(core.state.transcript.some(i => i.kind === 'user' && i.text === '（后台任务完成通知）')).toBe(true)

    dreamSpy.mockRestore()
    core.dispose()
  })

  it('onDone(false) 时任务标为 failed，不发通知', async () => {
    script.push({
      deltas: ['好的'],
      result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' },
    })

    const dreamSpy = vi.spyOn(autoDreamMod, 'runAutoDream').mockImplementation(async (deps) => {
      deps.onStart?.()
      deps.onDone?.(false)
    })

    const core = createChatCore({
      client: {} as any,
      yolo: true,
      cwd: '/tmp',
      sessionDir,
      onState: () => {},
    })

    await core.send('hello')
    await new Promise(r => setTimeout(r, 50))

    // 通知不应入队（failed 不通知）
    const notes = drainNotifications()
    expect(notes).toHaveLength(0)

    // 任务状态应为 failed
    const tasks = listTasks()
    const dreamTask = tasks.find(t => t.description.includes('dream'))
    expect(dreamTask?.status).toBe('failed')

    dreamSpy.mockRestore()
    core.dispose()
  })

  it('门控不过时（runAutoDream 内部 return）不注册任务、不发通知', async () => {
    script.push({
      deltas: ['好的'],
      result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' },
    })

    // 真实 runAutoDream 但注入 gate 永远不过
    const dreamSpy = vi.spyOn(autoDreamMod, 'runAutoDream').mockImplementation(async (_deps) => {
      // 不调用 onStart / onDone（模拟门控不过的行为）
    })

    const core = createChatCore({
      client: {} as any,
      yolo: true,
      cwd: '/tmp',
      sessionDir,
      onState: () => {},
    })

    await core.send('hello')
    await new Promise(r => setTimeout(r, 50))

    const notes = drainNotifications()
    expect(notes).toHaveLength(0)
    const tasks = listTasks().filter(t => t.description.includes('dream'))
    expect(tasks).toHaveLength(0)

    dreamSpy.mockRestore()
    core.dispose()
  })
})
