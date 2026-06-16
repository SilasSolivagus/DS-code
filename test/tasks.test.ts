// test/tasks.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  registerTask,
  getTask,
  listTasks,
  updateTask,
  removeTask,
  clearAllTasks,
  generateTaskId,
  enqueueNotification,
  drainNotifications,
  onNotification,
  formatNotification,
  formatTaskList,
  installTaskCleanup,
  cleanupOldTaskLogs,
  type BackgroundTask,
  type TaskNotification,
} from '../src/tasks.js'

function mkTask(over: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: over.id ?? 'b00000000',
    type: over.type ?? 'local_bash',
    status: over.status ?? 'running',
    description: over.description ?? 'echo hi',
    startTime: over.startTime ?? 1000,
    outputFile: over.outputFile ?? '/tmp/b00000000.log',
    outputOffset: over.outputOffset ?? 0,
    notified: over.notified ?? false,
    ...over,
  }
}

beforeEach(() => {
  clearAllTasks()
  drainNotifications() // 清空通知队列
})

describe('generateTaskId', () => {
  it('bash 前缀 b、长度 1+8、字符集 [0-9a-z]', () => {
    const id = generateTaskId('local_bash')
    expect(id[0]).toBe('b')
    expect(id.length).toBe(9)
    expect(id.slice(1)).toMatch(/^[0-9a-z]{8}$/)
  })

  it('agent 前缀 a', () => {
    const id = generateTaskId('local_agent')
    expect(id[0]).toBe('a')
    expect(id.length).toBe(9)
    expect(id.slice(1)).toMatch(/^[0-9a-z]{8}$/)
  })

  it('注入定长 rand → 确定输出', () => {
    // 8 个全 0 字节 → 全部映射到字符集第 0 位 '0'
    const rand = (n: number) => Buffer.alloc(n, 0)
    expect(generateTaskId('local_bash', rand)).toBe('b00000000')
    expect(generateTaskId('local_agent', rand)).toBe('a00000000')
  })

  it('注入定长 rand → 字符集末位', () => {
    // 35 落在字符集 '0-9a-z'（36 字符）最后一位 'z'
    const rand = (n: number) => Buffer.alloc(n, 35)
    expect(generateTaskId('local_bash', rand)).toBe('bzzzzzzzz')
  })
})

describe('registry CRUD', () => {
  it('register → get → list → update → remove', () => {
    const t = mkTask({ id: 'b1' })
    registerTask(t)
    expect(getTask('b1')).toBe(t)
    expect(listTasks()).toEqual([t])

    updateTask('b1', { status: 'completed', endTime: 2000 })
    expect(getTask('b1')!.status).toBe('completed')
    expect(getTask('b1')!.endTime).toBe(2000)

    removeTask('b1')
    expect(getTask('b1')).toBeUndefined()
    expect(listTasks()).toEqual([])
  })

  it('updateTask 对不存在 id 无副作用', () => {
    updateTask('nope', { status: 'failed' })
    expect(getTask('nope')).toBeUndefined()
  })

  it('clearAllTasks 清空', () => {
    registerTask(mkTask({ id: 'b1' }))
    registerTask(mkTask({ id: 'b2' }))
    expect(listTasks().length).toBe(2)
    clearAllTasks()
    expect(listTasks()).toEqual([])
  })
})

describe('enqueueNotification / drain / onNotification', () => {
  it('首次入队、第二次（notified 已 true）不重复', () => {
    const t = mkTask({ id: 'b1', status: 'completed' })
    registerTask(t)

    enqueueNotification(t)
    expect(t.notified).toBe(true) // check-and-set 落到 registry，对象同引用
    expect(getTask('b1')!.notified).toBe(true)

    enqueueNotification(t) // 已 notified → 跳过
    const drained = drainNotifications()
    expect(drained.length).toBe(1)
    expect(drained[0].id).toBe('b1')
  })

  it('drain 返回并清空', () => {
    const t = mkTask({ id: 'b1', status: 'completed' })
    registerTask(t)
    enqueueNotification(t)
    expect(drainNotifications().length).toBe(1)
    expect(drainNotifications().length).toBe(0)
  })

  it('onNotification 回调被触发；退订后不再触发', () => {
    let calls = 0
    const off = onNotification(() => { calls++ })
    const t = mkTask({ id: 'b1', status: 'completed' })
    registerTask(t)
    enqueueNotification(t)
    expect(calls).toBe(1)

    off()
    const t2 = mkTask({ id: 'b2', status: 'completed' })
    registerTask(t2)
    enqueueNotification(t2)
    expect(calls).toBe(1)
  })

  it('agent 任务通知携带 result，bash 携带 outputFile', () => {
    const a = mkTask({ id: 'a1', type: 'local_agent', status: 'completed', result: '子代理结果' })
    registerTask(a)
    enqueueNotification(a)
    const n = drainNotifications()[0]
    expect(n.result).toBe('子代理结果')
    expect(n.outputFile).toBeUndefined()

    const b = mkTask({ id: 'b1', type: 'local_bash', status: 'completed', outputFile: '/tmp/b1.log' })
    registerTask(b)
    enqueueNotification(b)
    const nb = drainNotifications()[0]
    expect(nb.outputFile).toBe('/tmp/b1.log')
    expect(nb.result).toBeUndefined()
  })
})

describe('formatNotification', () => {
  it('bash completed → 含 output-file，无 result', () => {
    const n: TaskNotification = { id: 'b1', status: 'completed', summary: '命令退出码 0', outputFile: '/tmp/b1.log' }
    const out = formatNotification(n)
    expect(out).toContain('<task-notification>')
    expect(out).toContain('<task-id>b1</task-id>')
    expect(out).toContain('<status>completed</status>')
    expect(out).toContain('<summary>命令退出码 0</summary>')
    expect(out).toContain('<output-file>/tmp/b1.log</output-file>')
    expect(out).not.toContain('<result>')
    expect(out).toContain('</task-notification>')
  })

  it('agent completed → 含 result，无 output-file', () => {
    const n: TaskNotification = { id: 'a1', status: 'completed', summary: '子代理完成', result: '最终文本' }
    const out = formatNotification(n)
    expect(out).toContain('<status>completed</status>')
    expect(out).toContain('<result>最终文本</result>')
    expect(out).not.toContain('<output-file>')
  })

  it('failed / killed 状态', () => {
    expect(formatNotification({ id: 'b1', status: 'failed', summary: '退出码 1' })).toContain('<status>failed</status>')
    expect(formatNotification({ id: 'b1', status: 'killed', summary: '已停止' })).toContain('<status>killed</status>')
  })
})

describe('formatTaskList', () => {
  it('多任务每行 {id} [{status}] {description}', () => {
    const tasks: BackgroundTask[] = [
      mkTask({ id: 'b1', status: 'running', description: 'npm run dev' }),
      mkTask({ id: 'a1', status: 'completed', description: '调查 bug' }),
    ]
    expect(formatTaskList(tasks)).toBe('b1 [running] npm run dev\na1 [completed] 调查 bug')
  })

  it('空列表 → 文案', () => {
    expect(formatTaskList([])).toBe('（无后台任务）')
  })
})

describe('installTaskCleanup', () => {
  // installTaskCleanup 模块级幂等（首次调用后内部 flag 永久为 true）。
  // 在本测试文件首次 install 之前记录基线，install 后断言每信号只多一个监听；二次调用不再增。
  const EVENTS = ['exit', 'SIGINT', 'SIGTERM'] as const

  it('幂等：注册后每信号 +1 监听，重复调不再增', () => {
    const before = new Map(EVENTS.map(e => [e, process.listenerCount(e)]))
    installTaskCleanup()
    for (const e of EVENTS) expect(process.listenerCount(e)).toBe(before.get(e)! + 1)

    installTaskCleanup() // 二次：幂等，不再加
    for (const e of EVENTS) expect(process.listenerCount(e)).toBe(before.get(e)! + 1)
  })

  it('触发 SIGINT 钩子 → running bash kill、running agent abort，非 running 不动', () => {
    installTaskCleanup() // 已装；取已注册的 handler 手动触发
    const handler = process.listeners('SIGINT').at(-1) as (sig: NodeJS.Signals) => void

    const bashKill = vi.fn()
    const agentAbort = vi.fn()
    const doneBashKill = vi.fn()
    registerTask(mkTask({ id: 'brun', type: 'local_bash', status: 'running', child: { kill: bashKill } as any }))
    registerTask(mkTask({ id: 'arun', type: 'local_agent', status: 'running', abortController: { abort: agentAbort } as any }))
    registerTask(mkTask({ id: 'bdone', type: 'local_bash', status: 'completed', child: { kill: doneBashKill } as any }))

    handler('SIGINT')

    expect(bashKill).toHaveBeenCalledWith('SIGKILL')
    expect(agentAbort).toHaveBeenCalledTimes(1)
    expect(doneBashKill).not.toHaveBeenCalled()
  })
})

describe('cleanupOldTaskLogs', () => {
  // 用真实 TASKS_DIR（~/.deepcode/tasks），唯一前缀避免误删他人文件，结束清理自身产物。
  const dir = path.join(os.homedir(), '.deepcode', 'tasks')
  const prefix = `cleanuptest-${process.pid}-`
  const mk = (name: string) => path.join(dir, prefix + name + '.log')

  afterEach(() => {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(prefix)) try { fs.unlinkSync(path.join(dir, f)) } catch { /* ignore */ }
      }
    } catch { /* dir 不存在 */ }
  })

  it('超龄删除、未超龄保留', () => {
    fs.mkdirSync(dir, { recursive: true })
    const now = 1_000_000_000_000
    const maxAge = 7 * 24 * 3600 * 1000
    const old = mk('old')
    const fresh = mk('fresh')
    fs.writeFileSync(old, 'x')
    fs.writeFileSync(fresh, 'x')
    // old：mtime 远早于 now-maxAge；fresh：mtime = now
    fs.utimesSync(old, new Date(now - maxAge - 1000), new Date(now - maxAge - 1000))
    fs.utimesSync(fresh, new Date(now), new Date(now))

    cleanupOldTaskLogs(maxAge, now)

    expect(fs.existsSync(old)).toBe(false)
    expect(fs.existsSync(fresh)).toBe(true)
  })

  it('非 .log 文件不删', () => {
    fs.mkdirSync(dir, { recursive: true })
    const now = 1_000_000_000_000
    const maxAge = 7 * 24 * 3600 * 1000
    const txt = path.join(dir, prefix + 'keep.txt')
    fs.writeFileSync(txt, 'x')
    fs.utimesSync(txt, new Date(now - maxAge - 1000), new Date(now - maxAge - 1000))

    cleanupOldTaskLogs(maxAge, now)

    expect(fs.existsSync(txt)).toBe(true)
    try { fs.unlinkSync(txt) } catch { /* ignore */ }
  })

  it('目录不存在 → no-op（不抛）', () => {
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(() => { throw new Error('ENOENT') })
    expect(() => cleanupOldTaskLogs()).not.toThrow()
    spy.mockRestore()
  })
})
