// test/services/scheduler/scheduler.test.ts
import { describe, it, expect, vi } from 'vitest'
import { SchedulerService } from '../../../src/services/scheduler/index.js'

function mk(overrides: Partial<{ idle: boolean; merged: boolean }> = {}) {
  const fired: string[] = []
  let idle = overrides.idle ?? true
  const svc = new SchedulerService({
    isIdle: () => idle,
    fire: (_d, p) => fired.push(p),
    cwd: () => '/tmp/proj',
    doneMeansMerged: () => overrides.merged ?? false,
  })
  return { svc, fired, setIdle: (v: boolean) => (idle = v) }
}

describe('scheduleWakeup', () => {
  it('到期且 idle 触发，解析哨兵', () => {
    const { svc, fired } = mk()
    const now = 1_000_000_000_000
    svc.scheduleWakeup(60, 'r', '<<autonomous-loop-dynamic>>', now)
    svc.tick(now + 60_000)        // 还没到整分钟边界？取整后稍晚
    svc.tick(now + 180_000)       // 充分晚 → 触发
    expect(fired.length).toBe(1)
    expect(fired[0]).toContain('Autonomous loop tick (dynamic pacing)')
  })
  it('busy 时不触发，转 idle 后下个 tick 触发', () => {
    const { svc, fired, setIdle } = mk({ idle: false })
    const now = 1_000_000_000_000
    svc.scheduleWakeup(60, 'r', '做 X', now)
    svc.tick(now + 180_000)
    expect(fired.length).toBe(0)
    setIdle(true)
    svc.tick(now + 200_000)
    expect(fired).toEqual(['做 X'])
  })
  it('wakeup 触发后从队列移除（一次性）', () => {
    const { svc, fired } = mk()
    const now = 1_000_000_000_000
    svc.scheduleWakeup(60, 'r', 'X', now)
    svc.tick(now + 180_000)
    svc.tick(now + 240_000)
    expect(fired.length).toBe(1)
    expect(svc.list().length).toBe(0)
  })
})

describe('keepalive', () => {
  it('turn 末未续 → 武装 1200s 兜底；连续两次不续 → 不再武装（循环结束）', () => {
    const { svc } = mk()
    svc.onTurnEndedWithoutReschedule() // 第一次：武装兜底
    expect(svc.list().some(e => e.kind === 'wakeup')).toBe(true)
    svc.cancel(svc.list()[0].id) // 模拟兜底被清/未续
    svc.onTurnEndedWithoutReschedule() // 第二次：budget 耗尽，不武装
    expect(svc.list().some(e => e.kind === 'wakeup')).toBe(false)
  })
  it('显式 scheduleWakeup 重置 keepalive budget', () => {
    const { svc } = mk()
    const now = 1_000_000_000_000
    svc.onTurnEndedWithoutReschedule()
    svc.scheduleWakeup(60, 'r', 'X', now) // 显式续 → 重置
    svc.onTurnEndedWithoutReschedule()
    expect(svc.list().some(e => e.kind === 'wakeup' && e.reason === 'keepalive')).toBe(true)
  })
})

describe('tick 序列化（每次至多触发一条）', () => {
  it('两条同时到期 → 第一个 tick 只触发一条，busy 解除后第二个 tick 触发第二条', () => {
    let busy = false
    const fired: string[] = []
    const svc = new SchedulerService({
      isIdle: () => !busy,
      fire: (_d, p) => { fired.push(p); busy = true },
      cwd: () => '/tmp/proj',
      doneMeansMerged: () => false,
    })
    const now = 1_000_000_000_000
    svc.scheduleWakeup(60, 'r1', 'A', now)
    svc.scheduleWakeup(60, 'r2', 'B', now)
    svc.tick(now + 180_000)
    expect(fired.length).toBe(1)
    busy = false
    svc.tick(now + 200_000)
    expect(fired.length).toBe(2)
  })

  it('两条即时到期的 one-shot cron → 两次 tick 各触发一条，之后队列清空', () => {
    const fired: string[] = []
    const svc = new SchedulerService({
      isIdle: () => true,
      fire: (_d, p) => fired.push(p),
      cwd: () => '/tmp/proj',
      doneMeansMerged: () => false,
    })
    const now = 1_000_000_000_000
    // 直接 push 两条即时到期的 one-shot cron 条目（模拟 reload missedOneShots 路径）
    ;(svc as any).entries.push(
      { id: 'm1', kind: 'cron', cron: '* * * * *', prompt: 'M1', recurring: false, durable: false, createdAt: now - 1000, nextFireAt: now },
      { id: 'm2', kind: 'cron', cron: '* * * * *', prompt: 'M2', recurring: false, durable: false, createdAt: now - 1000, nextFireAt: now },
    )
    svc.tick(now)
    expect(fired.length).toBe(1)
    svc.tick(now + 100)
    expect(fired.length).toBe(2)
    expect(svc.list().length).toBe(0)
  })
})

describe('addCron / recurring', () => {
  it('recurring 触发后重算 nextFireAt（不移除）', () => {
    const { svc, fired } = mk()
    const now = new Date(2026, 5, 30, 9, 29, 30).getTime()
    svc.addCron({ id: 'c1', kind: 'cron', cron: '* * * * *', prompt: 'P', recurring: true, durable: false, createdAt: now, nextFireAt: 0 }, now)
    svc.tick(new Date(2026, 5, 30, 9, 31, 0).getTime())
    expect(fired.length).toBeGreaterThanOrEqual(1)
    expect(svc.list().some(e => e.id === 'c1')).toBe(true)
  })
  it('one-shot 触发后移除', () => {
    const { svc } = mk()
    const now = new Date(2026, 5, 30, 9, 29, 30).getTime()
    svc.addCron({ id: 'c2', kind: 'cron', cron: '* * * * *', prompt: 'P', recurring: false, durable: false, createdAt: now, nextFireAt: 0 }, now)
    svc.tick(new Date(2026, 5, 30, 9, 31, 0).getTime())
    expect(svc.list().some(e => e.id === 'c2')).toBe(false)
  })
  it('recurring 超 7 天 age-out：最终一跑后移除', () => {
    const { svc, fired } = mk()
    const created = new Date(2026, 5, 1, 9, 0, 0).getTime()
    svc.addCron({ id: 'c3', kind: 'cron', cron: '* * * * *', prompt: 'P', recurring: true, durable: false, createdAt: created, nextFireAt: 0 }, created)
    svc.tick(new Date(2026, 5, 30, 9, 31, 0).getTime()) // 29 天后
    expect(fired.length).toBe(1)
    expect(svc.list().some(e => e.id === 'c3')).toBe(false)
  })
})
