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
})
