// test/backgroundCommand.test.ts —— 7.3 Task4：ChatCore.backgroundSession（门控 + fork + 写 state + spawn 注入）
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

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
// 记忆提取器 fire-and-forget，归零防止消耗 chatStream mock 脚本
vi.mock('../src/subagentRunner.js', async orig => ({ ...(await orig() as any), runSubagent: vi.fn(async () => 'ok') }))

const MOCK_SETTINGS = { permissions: { allow: [] as string[], deny: [] as string[] } }
vi.mock('../src/config.js', async orig => {
  const actual = await orig() as any
  return {
    ...actual,
    loadSettings: () => ({ ...actual.loadSettings(), ...MOCK_SETTINGS }),
    addUserAllowRule: vi.fn(() => []),
    removeUserAllowRule: vi.fn(() => undefined),
    listUserAllowRules: vi.fn(() => []),
    saveRawUserSettings: vi.fn(),
  }
})
vi.mock('../src/settingsLayers.js', async orig => ({
  ...(await orig() as any),
  loadLayeredSettings: () => ({
    settings: { permissions: { allow: [], deny: [] } },
    provenance: {},
    permissionSources: { allow: {}, deny: {} },
    scopes: [],
  }),
}))

import { createChatCore } from '../src/tui/useChat.js'
import { writeJobState, readJobState, type JobState } from '../src/backgroundSession.js'

const usage = { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0 }

let tmp: string
let sessionDir: string
beforeEach(() => {
  script.length = 0
  vi.clearAllMocks()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-bgcmd-'))
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-bgcmd-sessions-'))
  process.env.DEEPCODE_TEST_HOME = tmp
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(sessionDir, { recursive: true, force: true })
  delete process.env.DEEPCODE_TEST_HOME
})

function makeCore(extra: { spawnFn?: any; killFn?: any }) {
  return createChatCore({
    client: {} as any, yolo: true, cwd: '/proj', sessionDir, onState: () => {},
    spawnFn: extra.spawnFn,
    killFn: extra.killFn,
  })
}

function makeJob(overrides: Partial<JobState>): JobState {
  const short = overrides.short ?? 'abc12345'
  return {
    sessionId: short + '-full',
    short,
    state: 'working',
    cwd: '/proj',
    name: '测试 job',
    pid: 1234,
    model: 'test-model',
    permMode: 'default',
    sessionFile: `/tmp/${short}.jsonl`,
    backend: 'detached',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

describe('backgroundSession core', () => {
  it('空会话拒绝、不 spawn', async () => {
    const spawn = vi.fn()
    const core = makeCore({ spawnFn: spawn })
    const r = await core.backgroundSession()
    expect(r.ok).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('有消息 → fork 文件 + 写 state + spawn argv 正确', async () => {
    const spawn = vi.fn((..._args: any[]) => ({ pid: 5555, unref: () => {} }) as any)
    const core = makeCore({ spawnFn: spawn })
    script.push({ result: { content: '回答', toolCalls: [], usage, finishReason: 'stop' } })
    await core.send('先发一句') // 走 mock client 跑一轮，产生消息

    const before = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'))

    const r = await core.backgroundSession('继续在后台干')
    expect(r.ok).toBe(true)
    expect(spawn).toHaveBeenCalledOnce()
    const argv = spawn.mock.calls[0][1] as string[]
    expect(argv).toContain('--background-run')
    expect(argv).toContain('--job')

    // fork 出的会话文件独立于原会话（原文件不变，多了一个新文件）
    const after = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'))
    expect(after.length).toBe(before.length + 1)

    // state.json 写入 jobs 目录（DEEPCODE_TEST_HOME 隔离）、working、pid 已回填
    const jobsDir = path.join(tmp, '.deepcode', 'jobs')
    const shorts = fs.readdirSync(jobsDir)
    expect(shorts.length).toBe(1)
    const st = JSON.parse(fs.readFileSync(path.join(jobsDir, shorts[0], 'state.json'), 'utf8'))
    expect(st.state).toBe('working')
    expect(st.pid).toBe(5555)
  })
})

describe('/stop 命令', () => {
  it('无 id → 列出运行中 job', async () => {
    // pid 用当前进程（存活）：/stop 无参走 reconcileJobs，死 pid 会被判 failed 而滤出列表
    writeJobState(makeJob({ short: 'aaa11111', name: 'job A', state: 'working', pid: process.pid }))
    writeJobState(makeJob({ short: 'bbb22222', name: 'job B', state: 'working', pid: process.pid }))
    writeJobState(makeJob({ short: 'ccc33333', name: 'job C', state: 'completed' }))
    const core = makeCore({})
    await core.send('/stop')
    const notices = core.state.transcript.filter((i: any) => i.kind === 'notice') as any[]
    const text = notices.map(n => n.text).join('\n')
    expect(text).toContain('aaa11111')
    expect(text).toContain('bbb22222')
    expect(text).not.toContain('ccc33333')
  })

  it('无运行中 job 时提示无', async () => {
    const core = makeCore({})
    await core.send('/stop')
    const notices = core.state.transcript.filter((i: any) => i.kind === 'notice') as any[]
    expect(notices.some(n => n.text.includes('无运行中的后台会话'))).toBe(true)
  })

  it('有 id → process.kill(pid,SIGTERM) + state stopped', async () => {
    const kill = vi.fn()
    // pid 用当前进程（存活）：新增的僵尸校正只在 pid 已死时才跳过 kill，这里要走 kill 分支
    writeJobState(makeJob({ short: 'ddd44444', pid: process.pid, state: 'working' }))
    const core = makeCore({ killFn: kill })
    await core.send('/stop ddd44444')
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM')
    expect(readJobState('ddd44444')?.state).toBe('stopped')
    const notices = core.state.transcript.filter((i: any) => i.kind === 'notice') as any[]
    expect(notices.some(n => n.text.includes('已停止'))).toBe(true)
  })

  it('pid 已死的 working job → 不调用 killFn，标记 failed 并提示', async () => {
    const kill = vi.fn()
    writeJobState(makeJob({ short: 'hhh88888', pid: 2147483646, state: 'working' }))
    const core = makeCore({ killFn: kill })
    await core.send('/stop hhh88888')
    expect(kill).not.toHaveBeenCalled()
    expect(readJobState('hhh88888')?.state).toBe('failed')
    const notices = core.state.transcript.filter((i: any) => i.kind === 'notice') as any[]
    expect(notices.some(n => n.text.includes('hhh88888') && n.text.includes('failed'))).toBe(true)
  })

  it('未知 id → 提示找不到', async () => {
    const kill = vi.fn()
    const core = makeCore({ killFn: kill })
    await core.send('/stop nope0000')
    expect(kill).not.toHaveBeenCalled()
    const notices = core.state.transcript.filter((i: any) => i.kind === 'notice') as any[]
    expect(notices.some(n => n.text.includes('找不到'))).toBe(true)
  })

  it('已终态 id → 提示已是该状态', async () => {
    const kill = vi.fn()
    writeJobState(makeJob({ short: 'eee55555', state: 'completed' }))
    const core = makeCore({ killFn: kill })
    await core.send('/stop eee55555')
    expect(kill).not.toHaveBeenCalled()
    const notices = core.state.transcript.filter((i: any) => i.kind === 'notice') as any[]
    expect(notices.some(n => n.text.includes('completed'))).toBe(true)
  })
})

describe('askConfirm（7.3 Task6）', () => {
  it('选中 yes 选项 → resolve true', async () => {
    const core = makeCore({})
    const p = core.askConfirm('确认？', '标题', '是', '否')
    // 等 pendingQuestion 挂起后再回答（questionAsk 内 setState 是同步的，microtask 后即可见）
    await Promise.resolve()
    expect(core.state.pendingQuestion).not.toBeNull()
    core.resolveQuestion([{ header: '标题', question: '确认？', selected: ['是'] }])
    expect(await p).toBe(true)
  })

  it('选中 no 选项 → resolve false', async () => {
    const core = makeCore({})
    const p = core.askConfirm('确认？', '标题', '是', '否')
    await Promise.resolve()
    core.resolveQuestion([{ header: '标题', question: '确认？', selected: ['否'] }])
    expect(await p).toBe(false)
  })

  it('答案为 null（用户取消）→ resolve false', async () => {
    const core = makeCore({})
    const p = core.askConfirm('确认？', '标题', '是', '否')
    await Promise.resolve()
    core.resolveQuestion(null)
    expect(await p).toBe(false)
  })
})

describe('resumeList 并入 bg 会话（7.3 Task6）', () => {
  it('bg working job 排在 resumeList 前面，预览带 [bg state] 前缀', async () => {
    // pid 用当前进程（存活）：resumeList 走 reconcileJobs，死 pid 会被判 failed 改变预览文案
    writeJobState(makeJob({ short: 'fff66666', name: '后台任务', state: 'working', cwd: '/proj', sessionFile: '/tmp/fff66666.jsonl', pid: process.pid }))
    const core = makeCore({})
    const list = core.resumeList()
    expect(list[0]).toEqual({ file: '/tmp/fff66666.jsonl', preview: '[bg working] 后台任务' })
  })

  it('不同 cwd 的 job 不混入', async () => {
    writeJobState(makeJob({ short: 'ggg77777', name: '别处任务', state: 'working', cwd: '/other', sessionFile: '/tmp/ggg77777.jsonl' }))
    const core = makeCore({})
    const list = core.resumeList()
    expect(list.some(s => s.file === '/tmp/ggg77777.jsonl')).toBe(false)
  })

  it('同一 sessionFile 已在 sessions 列表中时去重（不重复出现）', async () => {
    const spawn = vi.fn((..._args: any[]) => ({ pid: 5555, unref: () => {} }) as any)
    const core = makeCore({ spawnFn: spawn })
    script.push({ result: { content: '回答', toolCalls: [], usage, finishReason: 'stop' } })
    await core.send('先发一句')
    const r = await core.backgroundSession('继续在后台干')
    expect(r.ok).toBe(true)
    const list = core.resumeList()
    const files = list.map(s => s.file)
    expect(new Set(files).size).toBe(files.length)
  })

  it('fork 会话文件既在 sessions 又是 bg job 时，就地显示 [bg state] 标签（M9）', async () => {
    // pid 用存活进程，reconcileJobs 保持 working
    const spawn = vi.fn((..._args: any[]) => ({ pid: process.pid, unref: () => {} }) as any)
    const core = makeCore({ spawnFn: spawn })
    script.push({ result: { content: '回答', toolCalls: [], usage, finishReason: 'stop' } })
    await core.send('先发一句')
    const r = await core.backgroundSession('后台干活')
    expect(r.ok).toBe(true)
    const list = core.resumeList()
    const bgEntry = list.find(s => s.preview.startsWith('[bg '))
    expect(bgEntry).toBeDefined()
    expect(bgEntry!.preview).toMatch(/^\[bg working\]/)
    // 不因带标签而重复：同一文件仍只一条
    const files = list.map(s => s.file)
    expect(new Set(files).size).toBe(files.length)
  })
})
