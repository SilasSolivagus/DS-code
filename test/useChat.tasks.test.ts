// test/useChat.tasks.test.ts
// L-041 Task 6：useChat 空闲唤醒 + 任务工具注册 + 主会话注入 deps
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
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

import { createChatCore } from '../src/tui/useChat.js'
import {
  registerTask,
  enqueueNotification,
  getTask,
  clearAllTasks,
  drainNotifications,
} from '../src/tasks.js'

const usage = { prompt_tokens: 50, completion_tokens: 20, prompt_cache_hit_tokens: 40 }

let sessionDir: string
beforeEach(() => {
  script.length = 0
  vi.clearAllMocks()
  clearAllTasks()
  drainNotifications() // 清空模块级通知队列，防止跨测试泄漏
  sessionDir = mkdtempSync(path.join(tmpdir(), 'deepcode-test-'))
})

/** 造一条已完成的后台任务并入队（注意 enqueue 内部会 check-and-set notified） */
function makeCompletedTask(id: string): void {
  registerTask({
    id,
    type: 'local_bash',
    status: 'completed',
    description: 'echo hi',
    startTime: 0,
    endTime: 1,
    outputFile: `/tmp/${id}.log`,
    outputOffset: 0,
    notified: false,
    command: 'echo hi',
  })
}

async function chatStreamMock() {
  return (await import('../src/api.js') as any).chatStream
}

describe('useChat 任务工具注册', () => {
  it('tools 数组含 BgTaskList/TaskOutput/TaskStop（通过一轮工具调用断言模型可用三工具）', async () => {
    // 模型第一轮调用 BgTaskList → loop 执行 → 第二轮收尾
    script.push({
      deltas: [],
      result: { content: '', toolCalls: [{ id: 'tc1', name: 'BgTaskList', args: '{}' }], usage, finishReason: 'tool_calls' },
    })
    script.push({
      deltas: ['好的'],
      result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' },
    })
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    await core.send('列出后台任务')
    // BgTaskList 工具被识别并执行（无「工具不存在」错误 preview）
    const tools = core.state.transcript.filter(i => i.kind === 'tool') as any[]
    expect(tools.some(t => t.name === 'BgTaskList')).toBe(true)
    expect(tools.every(t => !t.preview?.includes('不存在'))).toBe(true)
    core.dispose()
  })
})

describe('useChat 空闲唤醒', () => {
  it('idle 时收到完成通知 → 自动发起一轮，模型收到含 <task-notification> 的 user 消息', async () => {
    // 唤醒触发的这一轮：模型无工具调用，直接收尾
    script.push({
      deltas: ['收到，任务完成'],
      result: { content: '收到，任务完成', toolCalls: [], usage, finishReason: 'stop' },
    })
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    expect(core.state.busy).toBe(false)

    makeCompletedTask('btest0001')
    enqueueNotification(getTask('btest0001')!) // idle → 触发 wakeOnNotification

    // 唤醒是 fire-and-forget（void runTurn），轮询等待 busy 复位
    await vi.waitFor(() => expect(core.state.busy).toBe(false), { timeout: 1000 })

    const cs = await chatStreamMock()
    expect(cs.mock.calls.length).toBe(1) // 自动发起了一轮
    // 该轮 messages 含 <task-notification>
    const sentMessages = cs.mock.calls[0][1].messages as any[]
    const injected = sentMessages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('<task-notification>'))
    expect(injected).toBeDefined()
    expect(injected.content).toContain('btest0001')
    // 唤醒走 runTurn 路径，transcript 出现唤醒 user 标记
    expect(core.state.transcript.some(i => i.kind === 'user' && i.text === '（后台任务完成通知）')).toBe(true)
    core.dispose()
  })

  it('busy 时收到通知不抢跑：由 runLoop 终止点注入续跑，不另起空闲唤醒 runTurn', async () => {
    script.push({
      // 第一轮：工具调用（占住 busy 期间入队通知）
      deltas: [],
      result: { content: '', toolCalls: [{ id: 'tc1', name: 'BgTaskList', args: '{}' }], usage, finishReason: 'tool_calls' },
    })
    script.push({
      // 第二轮：收尾（无工具调用）→ runLoop 终止点 drain 注入通知 → continue
      deltas: ['完成'],
      result: { content: '完成', toolCalls: [], usage, finishReason: 'stop' },
    })
    script.push({
      // 第三轮：注入通知后模型续跑的回复
      deltas: ['已收到后台通知'],
      result: { content: '已收到后台通知', toolCalls: [], usage, finishReason: 'stop' },
    })
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })

    const p = core.send('跑个工具')
    // send 已开始（busy=true）。此刻入队通知——busy 守卫阻止空闲唤醒，通知留在队列由 runLoop 注入。
    makeCompletedTask('btest0002')
    enqueueNotification(getTask('btest0002')!)
    await p

    const cs = await chatStreamMock()
    // 3 次 chatStream：工具轮 + 收尾轮 + 注入续跑轮。注入是 runLoop 的合法行为，非空闲唤醒抢跑。
    expect(cs.mock.calls.length).toBe(3)
    // 关键：busy 期间没有并发再起一个空闲唤醒 runTurn（无「后台任务完成通知」user 块）。
    const wakeUserItems = core.state.transcript.filter(i => i.kind === 'user' && i.text === '（后台任务完成通知）')
    expect(wakeUserItems.length).toBe(0)
    // 注入续跑使模型收到含 <task-notification> 的 user 消息（由 runLoop 注入，第三轮 messages 含之）
    const thirdMessages = cs.mock.calls[2][1].messages as any[]
    expect(thirdMessages.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('<task-notification>'))).toBe(true)
    expect(core.state.busy).toBe(false)
    core.dispose()
  })

  it('dispose 后再入队通知不触发唤醒', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    core.dispose()

    makeCompletedTask('btest0003')
    enqueueNotification(getTask('btest0003')!)
    // 给微任务时间
    await Promise.resolve()
    await Promise.resolve()

    const cs = await chatStreamMock()
    expect(cs.mock.calls.length).toBe(0) // 退订后无唤醒
    expect(core.state.busy).toBe(false)
  })
})
