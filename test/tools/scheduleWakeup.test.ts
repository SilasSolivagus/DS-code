import { describe, it, expect, beforeEach } from 'vitest'
import { scheduleWakeupTool, setScheduler } from '../../src/tools/scheduleWakeup.js'
import { SchedulerService } from '../../src/services/scheduler/index.js'

function fakeCtx(): any { return { signal: { aborted: false }, cwd: () => '/tmp', isSubagent: false } }

describe('ScheduleWakeup tool', () => {
  let fired: string[]
  beforeEach(() => {
    fired = []
    setScheduler(new SchedulerService({ isIdle: () => true, fire: (_d, p) => fired.push(p), cwd: () => '/tmp', doneMeansMerged: () => false }))
  })
  it('注册 wakeup 并回确认（含取整后时间）', async () => {
    const out = await scheduleWakeupTool.call({ delaySeconds: 120, reason: '等 CI', prompt: '<<autonomous-loop-dynamic>>' }, fakeCtx())
    expect(out).toMatch(/Next wakeup scheduled/)
  })
  it('isReadOnly + 不需权限', () => {
    expect(scheduleWakeupTool.isReadOnly).toBe(true)
    expect(scheduleWakeupTool.needsPermission({} as any)).toBe(false)
  })
  it('无 scheduler（非 /loop 上下文）→ 提示循环已结束，不抛', async () => {
    setScheduler(null)
    const out = await scheduleWakeupTool.call({ delaySeconds: 120, reason: 'r', prompt: 'P' }, fakeCtx())
    expect(out).toMatch(/Wakeup not scheduled/)
  })
})
