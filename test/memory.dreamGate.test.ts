import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { countSessionsTouchedSince, checkDreamGates } from '../src/services/memory/dreamGate.js'
import { DEFAULT_MEMORY_CONFIG } from '../src/memdir/memoryConfig.js'
import { sanitizeProjectKey, findGitRoot } from '../src/memdir/paths.js'

const dream = DEFAULT_MEMORY_CONFIG.dream

// 写含 cwd 的 meta 首行（模拟真实 session 文件格式）
function writeSession(file: string, cwd: string): void {
  fs.writeFileSync(file, JSON.stringify({ t: 'meta', cwd }) + '\n')
}

describe('countSessionsTouchedSince', () => {
  let sd: string
  let projectDir: string
  let projectKey: string
  beforeEach(() => {
    sd = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-sd-'))
    // 创建一个带 .git 的临时项目目录，作为"当前项目"
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-proj-'))
    fs.mkdirSync(path.join(projectDir, '.git'))
    // findGitRoot 用 realpathSync，所以 projectKey 也要用 realpath 计算，保证匹配
    projectKey = sanitizeProjectKey(findGitRoot(projectDir) ?? projectDir)
  })
  afterEach(() => {
    fs.rmSync(sd, { recursive: true, force: true })
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  test('统计 since 后、排除当前、只计匹配项目键的会话', () => {
    // a.jsonl = 当前会话（应排除）
    writeSession(path.join(sd, 'a.jsonl'), projectDir)
    // b.jsonl = 同项目的另一会话（应计入）
    writeSession(path.join(sd, 'b.jsonl'), projectDir)
    // c.jsonl = 同项目的另一会话（应计入）
    writeSession(path.join(sd, 'c.jsonl'), projectDir)
    expect(countSessionsTouchedSince(sd, 0, path.join(sd, 'a.jsonl'), projectKey)).toBe(2)
  })

  test('跨项目会话不计入（项目键不同）', () => {
    // a.jsonl = 当前会话（排除）
    writeSession(path.join(sd, 'a.jsonl'), projectDir)
    // b.jsonl = 另一项目的会话（不同 cwd，项目键不匹配，应跳过）
    writeSession(path.join(sd, 'b.jsonl'), '/some/other/project/path')
    // c.jsonl = 同项目（应计入）
    writeSession(path.join(sd, 'c.jsonl'), projectDir)
    expect(countSessionsTouchedSince(sd, 0, path.join(sd, 'a.jsonl'), projectKey)).toBe(1)
  })

  test('目录不存在 → 0', () => {
    expect(countSessionsTouchedSince('/nonexistent-xyz', 0, '/x/y.jsonl', projectKey)).toBe(0)
  })

  test('非 .jsonl 被过滤', () => {
    writeSession(path.join(sd, 'a.jsonl'), projectDir)
    fs.writeFileSync(path.join(sd, 'b.txt'), 'x')
    // a.jsonl 是当前文件 → 排除；b.txt 非 jsonl → 过滤
    expect(countSessionsTouchedSince(sd, 0, path.join(sd, 'a.jsonl'), projectKey)).toBe(0)
  })

  test('cwd 缺失或 JSON 无效 → 跳过该文件', () => {
    // 有效同项目会话
    writeSession(path.join(sd, 'a.jsonl'), projectDir)
    // 无效文件（不是 JSON）
    fs.writeFileSync(path.join(sd, 'bad.jsonl'), 'not-json\n')
    // 缺 cwd 的 meta
    fs.writeFileSync(path.join(sd, 'nocwd.jsonl'), JSON.stringify({ t: 'meta', model: 'm' }) + '\n')
    // 当前文件为 other.jsonl（不在 sd 目录）
    expect(countSessionsTouchedSince(sd, 0, '/other/path.jsonl', projectKey)).toBe(1)
  })
})

test('时间门控未到 → reason time', () => {
  const r = checkDreamGates({
    memdir: '/x', sessionsDir: '/s', currentSessionFile: '/s/cur.jsonl',
    projectKey: 'proj', cfg: dream,
    now: 1000, lastScanAt: 0, readLastAt: () => 1000 - 3600_000, countSessions: () => 10, // 1h前 < 24h
  })
  expect(r.pass).toBe(false)
  expect(r.reason).toBe('time')
})
test('时间+会话都满足 → pass', () => {
  const r = checkDreamGates({
    memdir: '/x', sessionsDir: '/s', currentSessionFile: '/s/cur.jsonl',
    projectKey: 'proj', cfg: dream,
    now: 1000 + 25 * 3600_000, lastScanAt: 0, readLastAt: () => 1000, countSessions: () => 5,
  })
  expect(r.pass).toBe(true)
})
test('时间过但会话不足 → reason sessions', () => {
  const r = checkDreamGates({
    memdir: '/x', sessionsDir: '/s', currentSessionFile: '/s/cur.jsonl',
    projectKey: 'proj', cfg: dream,
    now: 1000 + 25 * 3600_000, lastScanAt: 0, readLastAt: () => 1000, countSessions: () => 2,
  })
  expect(r.pass).toBe(false)
  expect(r.reason).toBe('sessions')
})
test('时间+会话满足但在 rescan 窗口内 → reason rescan-throttle', () => {
  const r = checkDreamGates({
    memdir: '/x', sessionsDir: '/s', currentSessionFile: '/s/cur.jsonl',
    projectKey: 'proj', cfg: dream,
    now: 1000 + 25 * 3600_000, lastScanAt: 1000 + 25 * 3600_000 - 300_000, // 5min 前刚扫过
    readLastAt: () => 1000, countSessions: () => 5, // 时间&会话都满足
  })
  expect(r.pass).toBe(false)
  expect(r.reason).toBe('rescan-throttle')
})
