import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { readLastConsolidatedAt, tryAcquireConsolidationLock, rollbackConsolidationLock } from '../src/services/memory/consolidationLock.js'

describe('consolidationLock', () => {
  let md: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-lock-')) })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }) })
  test('首次无锁 → 取锁成功，prior=0', () => {
    expect(readLastConsolidatedAt(md)).toBe(0)
    expect(tryAcquireConsolidationLock(md, Date.now(), () => false)).toBe(0)
    expect(fs.existsSync(path.join(md, '.consolidate-lock'))).toBe(true)
  })
  test('活跃 PID 且锁新鲜 → 拒绝', () => {
    tryAcquireConsolidationLock(md, Date.now(), () => false) // 占锁
    expect(tryAcquireConsolidationLock(md, Date.now(), () => true)).toBe(null)
  })
  test('rollback prior=0 删锁', () => {
    tryAcquireConsolidationLock(md, Date.now(), () => false)
    rollbackConsolidationLock(md, 0)
    expect(fs.existsSync(path.join(md, '.consolidate-lock'))).toBe(false)
  })
  test('死 PID → 抢占成功并返回旧 mtime', () => {
    tryAcquireConsolidationLock(md, 1000, () => true) // 占锁，mtime≈now
    const prior = readLastConsolidatedAt(md)
    const got = tryAcquireConsolidationLock(md, 1000 + 10, () => false) // PID 死 → 抢占
    expect(got).not.toBe(null)
    expect(Math.round(got as number)).toBeCloseTo(Math.round(prior), -1)
    expect(fs.readFileSync(path.join(md, '.consolidate-lock'), 'utf8')).toBe(String(process.pid))
  })
  test('陈旧锁(>1h)即使 PID 活跃也可抢占', () => {
    const lockFile = path.join(md, '.consolidate-lock')
    tryAcquireConsolidationLock(md, Date.now(), () => true) // 占锁
    // 把 mtime 设到 2 小时前，模拟陈旧锁
    const twoHoursAgo = new Date(Date.now() - 7200_000)
    fs.utimesSync(lockFile, twoHoursAgo, twoHoursAgo)
    const got = tryAcquireConsolidationLock(md, Date.now(), () => true) // PID 活跃但锁超 1h
    expect(got).not.toBe(null)
  })
  test('坏 PID 内容 → 视为可抢占', () => {
    fs.mkdirSync(md, { recursive: true })
    fs.writeFileSync(path.join(md, '.consolidate-lock'), 'garbage')
    const got = tryAcquireConsolidationLock(md, 1000, () => true)
    expect(got).not.toBe(null)
  })
  test('rollback(priorMtime>0) 回退 mtime', () => {
    tryAcquireConsolidationLock(md, 5000, () => false)
    rollbackConsolidationLock(md, 12345)
    expect(Math.round(readLastConsolidatedAt(md))).toBe(12345)
    expect(fs.existsSync(path.join(md, '.consolidate-lock'))).toBe(true)
  })
  test('readLastConsolidatedAt 取锁后非零', () => {
    tryAcquireConsolidationLock(md, 7777, () => false)
    expect(readLastConsolidatedAt(md)).toBeGreaterThan(0)
  })
})
