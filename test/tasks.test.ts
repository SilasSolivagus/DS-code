// test/tasks.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
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
