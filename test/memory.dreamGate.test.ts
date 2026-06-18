import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { countSessionsTouchedSince, checkDreamGates } from '../src/services/memory/dreamGate.js'
import { DEFAULT_MEMORY_CONFIG } from '../src/memdir/memoryConfig.js'

const dream = DEFAULT_MEMORY_CONFIG.dream

describe('countSessionsTouchedSince', () => {
  let sd: string
  beforeEach(() => { sd = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-sd-')) })
  afterEach(() => { fs.rmSync(sd, { recursive: true, force: true }) })
  test('统计 since 后、排除当前', () => {
    for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(sd, n + '.jsonl'), 'x')
    expect(countSessionsTouchedSince(sd, 0, path.join(sd, 'a.jsonl'))).toBe(2)
  })
  test('目录不存在 → 0', () => {
    expect(countSessionsTouchedSince('/nonexistent-xyz', 0, '/x/y.jsonl')).toBe(0)
  })
  test('非 .jsonl 被过滤', () => {
    fs.writeFileSync(path.join(sd, 'a.jsonl'), 'x')
    fs.writeFileSync(path.join(sd, 'b.txt'), 'x')
    expect(countSessionsTouchedSince(sd, 0, path.join(sd, 'a.jsonl'))).toBe(0) // 仅 a.jsonl 且=当前→排除
  })
  test('当前文件不在目录 → 全计数', () => {
    fs.writeFileSync(path.join(sd, 'a.jsonl'), 'x')
    fs.writeFileSync(path.join(sd, 'b.jsonl'), 'x')
    expect(countSessionsTouchedSince(sd, 0, '/other/path.jsonl')).toBe(2)
  })
})

test('时间门控未到 → reason time', () => {
  const r = checkDreamGates({
    memdir: '/x', sessionsDir: '/s', currentSessionFile: '/s/cur.jsonl', cfg: dream,
    now: 1000, lastScanAt: 0, readLastAt: () => 1000 - 3600_000, countSessions: () => 10, // 1h前 < 24h
  })
  expect(r.pass).toBe(false)
  expect(r.reason).toBe('time')
})
test('时间+会话都满足 → pass', () => {
  const r = checkDreamGates({
    memdir: '/x', sessionsDir: '/s', currentSessionFile: '/s/cur.jsonl', cfg: dream,
    now: 1000 + 25 * 3600_000, lastScanAt: 0, readLastAt: () => 1000, countSessions: () => 5,
  })
  expect(r.pass).toBe(true)
})
test('时间过但会话不足 → reason sessions', () => {
  const r = checkDreamGates({
    memdir: '/x', sessionsDir: '/s', currentSessionFile: '/s/cur.jsonl', cfg: dream,
    now: 1000 + 25 * 3600_000, lastScanAt: 0, readLastAt: () => 1000, countSessions: () => 2,
  })
  expect(r.pass).toBe(false)
  expect(r.reason).toBe('sessions')
})
test('时间+会话满足但在 rescan 窗口内 → reason rescan-throttle', () => {
  const r = checkDreamGates({
    memdir: '/x', sessionsDir: '/s', currentSessionFile: '/s/cur.jsonl', cfg: dream,
    now: 1000 + 25 * 3600_000, lastScanAt: 1000 + 25 * 3600_000 - 300_000, // 5min 前刚扫过
    readLastAt: () => 1000, countSessions: () => 5, // 时间&会话都满足
  })
  expect(r.pass).toBe(false)
  expect(r.reason).toBe('rescan-throttle')
})
