import { describe, it, expect, beforeEach } from 'vitest'
import { cronCreateTool, cronListTool, cronDeleteTool } from '../../src/tools/cron.js'
import { setScheduler } from '../../src/tools/scheduleWakeup.js'
import { SchedulerService } from '../../src/services/scheduler/index.js'

let svc: SchedulerService
beforeEach(() => {
  svc = new SchedulerService({ isIdle: () => true, fire: () => {}, cwd: () => '/tmp/p', doneMeansMerged: () => false })
  setScheduler(svc)
})

describe('CronCreate', () => {
  it('合法 cron → 注册并回 id', async () => {
    const out = await cronCreateTool.call({ cron: '0 9 * * *', prompt: 'P', recurring: true, durable: false }, {} as any)
    expect(out).toMatch(/已安排/)
    expect(svc.list().some(e => e.kind === 'cron')).toBe(true)
  })
  it('非法 cron → 拒绝不注册', async () => {
    const out = await cronCreateTool.call({ cron: '99 * * * *', prompt: 'P', recurring: true, durable: false }, {} as any)
    expect(out).toMatch(/无效/)
    expect(svc.list().length).toBe(0)
  })
})

describe('CronList/CronDelete', () => {
  it('list 列出，delete 删除', async () => {
    await cronCreateTool.call({ cron: '0 9 * * *', prompt: 'P', recurring: true, durable: false }, {} as any)
    const id = svc.list()[0].id
    expect(await cronListTool.call({}, {} as any)).toContain(id)
    await cronDeleteTool.call({ id }, {} as any)
    expect(svc.list().length).toBe(0)
  })
})
