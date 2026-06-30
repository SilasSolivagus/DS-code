import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { saveDurable, loadDurable, acquireLock, releaseLock, storePathFor } from '../../../src/services/scheduler/store.js'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const job = (id: string, extra: any = {}) => ({ id, kind: 'cron' as const, cron: '0 9 * * *', prompt: 'P', recurring: true, durable: true, createdAt: 1000, nextFireAt: 2000, ...extra })

describe('durable 往返', () => {
  it('save 后 load 拿回 durable job', () => {
    saveDurable(dir, [job('c1')])
    const { jobs } = loadDurable(dir, 3000)
    expect(jobs.map(j => j.id)).toEqual(['c1'])
    expect(fs.existsSync(storePathFor(dir))).toBe(true)
  })
  it('损坏文件不抛，返回空', () => {
    fs.mkdirSync(path.join(dir, '.deepcode'), { recursive: true })
    fs.writeFileSync(storePathFor(dir), '{坏 json')
    expect(loadDurable(dir, 3000)).toEqual({ jobs: [], missedOneShots: [] })
  })
})

describe('漏跑 one-shot 补偿', () => {
  it('non-recurring 且 nextFireAt < now → 进 missedOneShots，不进 jobs', () => {
    saveDurable(dir, [job('one', { recurring: false, nextFireAt: 500 })])
    const { jobs, missedOneShots } = loadDurable(dir, 3000)
    expect(jobs.length).toBe(0)
    expect(missedOneShots.map(j => j.id)).toEqual(['one'])
  })
})

describe('age-out', () => {
  it('recurring 超 7 天直接剔除', () => {
    const created = 1000
    saveDurable(dir, [job('old', { createdAt: created })])
    const { jobs } = loadDurable(dir, created + 8 * 24 * 3600_000)
    expect(jobs.length).toBe(0)
  })
})

describe('lock', () => {
  it('首获成功，重复获（不同 pid，锁新鲜）失败', () => {
    expect(acquireLock(dir, 111, 1000)).toBe(true)
    expect(acquireLock(dir, 222, 1000)).toBe(false)
  })
  it('陈旧锁（超时）可抢占', () => {
    acquireLock(dir, 111, 1000)
    expect(acquireLock(dir, 222, 1000 + 120_000)).toBe(true) // 锁 TTL 内为 false，超 TTL 可抢
  })
  it('release 后可再获', () => {
    acquireLock(dir, 111, 1000)
    releaseLock(dir)
    expect(acquireLock(dir, 222, 1000)).toBe(true)
  })
})
