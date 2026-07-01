import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  shortId, jobStateDir, writeJobState, readJobState, updateJobState,
  listJobs, formatJobList, cleanupOldJobs, buildBackgroundArgv, type JobState,
} from '../src/backgroundSession.js'

// 用临时 JOBS_DIR：backgroundSession 读 config.JOBS_DIR，测试用 env 覆盖 home
let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-jobs-'))
  process.env.DEEPCODE_TEST_HOME = tmp // config.JOBS_DIR 在 test 下改读此值（见 Step 4）
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
  it('取前 8 字符', () => { expect(shortId('abcd1234efgh')).toBe('abcd1234') })
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
