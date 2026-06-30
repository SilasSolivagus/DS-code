// test/tasks.kind.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { registerTask, enqueueNotification, drainNotifications, clearAllTasks } from '../src/tasks.js'

beforeEach(() => clearAllTasks())

describe('monitor kind 通知', () => {
  it('kind:monitor 通知 summary 带监控标签 + 事件文本进 result（否则 toNotification 丢 description）', () => {
    const t = { id: 'm1', type: 'local_bash', kind: 'monitor', status: 'running', description: 'EVENT 1', startTime: 0, outputFile: '/x', outputOffset: 0, notified: false } as any
    registerTask(t)
    enqueueNotification(t)
    const n = drainNotifications()
    expect(n[0].summary).toContain('监控')
    expect(n[0].result).toBe('EVENT 1') // 事件行文本必须可见
  })
})
