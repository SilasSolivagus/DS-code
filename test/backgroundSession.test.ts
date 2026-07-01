import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  shortId, jobStateDir, writeJobState, readJobState, updateJobState,
  listJobs, formatJobList, cleanupOldJobs, buildBackgroundArgv,
  isPidAlive, reconcileJobs, type JobState,
} from '../src/backgroundSession.js'

// 用临时 jobs 根目录：backgroundSession.jobsRoot() 自读 DEEPCODE_TEST_HOME 覆盖 home（不经 config.js）
let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-jobs-'))
  process.env.DEEPCODE_TEST_HOME = tmp
})
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.DEEPCODE_TEST_HOME })

function mkJob(over: Partial<JobState> = {}): JobState {
  return {
    sessionId: 'abcd1234efgh', short: 'abcd1234', state: 'working',
    cwd: '/proj', name: '跑个长任务', initialPrompt: '干活', pid: 4242,
    model: 'glm-5.2', permMode: 'default', sessionFile: '/s/abcd.jsonl',
    backend: 'detached', createdAt: 1000, updatedAt: 1000, ...over,
  }
}

describe('shortId', () => {
  it('返回确定性 8 位 hex', () => {
    const s = shortId('2026-07-01T10-17-08-545Z-g0x1')
    expect(s).toMatch(/^[0-9a-f]{8}$/)
    expect(shortId('2026-07-01T10-17-08-545Z-g0x1')).toBe(s) // 确定性：同输入同输出
  })

  // 回归：C1——deepcode sessionId 是时间戳文件名（非 UUID），同月/同日前缀相同；
  // 旧实现 slice(0,8) 会让同月的两个 job 撞进同一目录、互相覆盖 state.json。
  it('两个共享日期前缀的时间戳 sessionId 产生不同的 short（不再撞车）', () => {
    const a = shortId('2026-07-01T10-17-08-545Z-g0x1')
    const b = shortId('2026-07-01T10-22-51-901Z-k9zq')
    expect(a).not.toBe(b)
  })

  it('两个时间戳 sessionId 各自落在独立的 job 目录，互不覆盖', () => {
    const sidA = '2026-07-01T10-17-08-545Z-g0x1'
    const sidB = '2026-07-01T10-22-51-901Z-k9zq'
    const shortA = shortId(sidA)
    const shortB = shortId(sidB)
    expect(jobStateDir(shortA)).not.toBe(jobStateDir(shortB))
    writeJobState(mkJob({ sessionId: sidA, short: shortA, name: 'job A' }))
    writeJobState(mkJob({ sessionId: sidB, short: shortB, name: 'job B' }))
    expect(readJobState(shortA)?.name).toBe('job A')
    expect(readJobState(shortB)?.name).toBe('job B')
    expect(listJobs().length).toBe(2) // 旧实现下会因目录撞车退化成 1
  })
})

describe('write/read/update', () => {
  it('往返一致', () => {
    const j = mkJob()
    writeJobState(j)
    expect(readJobState('abcd1234')).toEqual(j)
  })
  it('update 合并 patch 并保留其余字段', () => {
    writeJobState(mkJob())
    const upd = updateJobState('abcd1234', { state: 'stopped', updatedAt: 2000 })
    expect(upd?.state).toBe('stopped')
    expect(upd?.updatedAt).toBe(2000)
    expect(upd?.name).toBe('跑个长任务')
    expect(readJobState('abcd1234')?.state).toBe('stopped')
  })
  it('读不存在返回 null', () => { expect(readJobState('nope0000')).toBeNull() })
})

describe('listJobs', () => {
  it('枚举全部 job，坏文件跳过', () => {
    writeJobState(mkJob({ short: 'aaaa1111', sessionId: 'aaaa1111xxxx' }))
    writeJobState(mkJob({ short: 'bbbb2222', sessionId: 'bbbb2222xxxx' }))
    // 坏文件
    fs.mkdirSync(jobStateDir('cccc3333'), { recursive: true })
    fs.writeFileSync(path.join(jobStateDir('cccc3333'), 'state.json'), '{坏 json')
    const jobs = listJobs()
    expect(jobs.map(j => j.short).sort()).toEqual(['aaaa1111', 'bbbb2222'])
  })
  it('空目录返回 []', () => { expect(listJobs()).toEqual([]) })
})

describe('formatJobList', () => {
  it('每行含 short/state/name', () => {
    const out = formatJobList([mkJob()], 1000)
    expect(out).toContain('abcd1234')
    expect(out).toContain('working')
    expect(out).toContain('跑个长任务')
  })
})

describe('cleanupOldJobs', () => {
  it('删超龄终态 job，保留 working 与新 job', () => {
    writeJobState(mkJob({ short: 'old00000', sessionId: 'old00000xxx', state: 'completed', updatedAt: 0 }))
    writeJobState(mkJob({ short: 'run00000', sessionId: 'run00000xxx', state: 'working', updatedAt: 0 }))
    writeJobState(mkJob({ short: 'new00000', sessionId: 'new00000xxx', state: 'completed', updatedAt: 9_999_000 }))
    cleanupOldJobs(1000, 10_000_000)
    expect(readJobState('old00000')).toBeNull()      // 终态且超龄 → 删
    expect(readJobState('run00000')).not.toBeNull()  // working → 保留
    expect(readJobState('new00000')).not.toBeNull()  // 未超龄 → 保留
  })
})

describe('isPidAlive', () => {
  it('当前进程 pid → true', () => { expect(isPidAlive(process.pid)).toBe(true) })
  it('确定已死的 pid → false', () => { expect(isPidAlive(2147483646)).toBe(false) })
  it('0 或负数 → false', () => {
    expect(isPidAlive(0)).toBe(false)
    expect(isPidAlive(-1)).toBe(false)
  })
})

describe('reconcileJobs', () => {
  it('working 且 pid 已死 → 变成 failed 并落盘', () => {
    writeJobState(mkJob({ short: 'dead0000', sessionId: 'dead0000xxx', state: 'working', pid: 2147483646, updatedAt: 1000 }))
    const out = reconcileJobs(5000)
    const j = out.find(x => x.short === 'dead0000')!
    expect(j.state).toBe('failed')
    expect(j.updatedAt).toBe(5000)
    expect(readJobState('dead0000')?.state).toBe('failed') // 落盘确认
  })
  it('working 且 pid 存活（当前进程）→ 保持 working', () => {
    writeJobState(mkJob({ short: 'live0000', sessionId: 'live0000xxx', state: 'working', pid: process.pid }))
    const out = reconcileJobs(5000)
    expect(out.find(x => x.short === 'live0000')?.state).toBe('working')
    expect(readJobState('live0000')?.state).toBe('working')
  })
  it('非 working（如 completed）→ 不动', () => {
    writeJobState(mkJob({ short: 'done0000', sessionId: 'done0000xxx', state: 'completed', pid: 2147483646, updatedAt: 1000 }))
    const out = reconcileJobs(5000)
    expect(out.find(x => x.short === 'done0000')?.state).toBe('completed')
    expect(readJobState('done0000')?.updatedAt).toBe(1000) // 未被改写
  })
  it('listJobs() 本身保持纯——不因死 pid 而改写', () => {
    writeJobState(mkJob({ short: 'pure0000', sessionId: 'pure0000xxx', state: 'working', pid: 2147483646 }))
    const jobs = listJobs()
    expect(jobs.find(j => j.short === 'pure0000')?.state).toBe('working')
    expect(readJobState('pure0000')?.state).toBe('working') // listJobs 未写盘
  })
})

describe('buildBackgroundArgv', () => {
  it('含 --background-run/--resume/--job；有 seed 加 -p；带 permMode/model', () => {
    const argv = buildBackgroundArgv({ entry: '/x/index.js', resumeFile: '/s/f.jsonl', short: 'abcd1234', seed: '继续', permMode: 'acceptEdits', model: 'glm-5.2' })
    expect(argv).toEqual(['/x/index.js', '--background-run', '--resume', '/s/f.jsonl', '--job', 'abcd1234', '-p', '继续', '--permission-mode', 'acceptEdits', '--model', 'glm-5.2'])
  })
  it('无 seed/无 permMode/无 model 时省略', () => {
    const argv = buildBackgroundArgv({ entry: '/x/index.js', resumeFile: '/s/f.jsonl', short: 'abcd1234' })
    expect(argv).toEqual(['/x/index.js', '--background-run', '--resume', '/s/f.jsonl', '--job', 'abcd1234'])
  })
})
