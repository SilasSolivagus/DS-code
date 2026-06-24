import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:child_process', async importOriginal => {
  const cp = await importOriginal<typeof import('node:child_process')>()
  return {
    ...cp,
    execSync: vi.fn(),
  }
})

import { COMMIT_GUIDANCE, COMMIT_PUSH_PR_GUIDANCE, buildCommitContext, buildPrContext, isEmptyDiff, resolveBaseBranch } from '../src/commitGuidance.js'
import { execSync } from 'node:child_process'

describe('COMMIT_GUIDANCE', () => {
  it('含 6 条 Safety Protocol 关键词', () => {
    for (const k of ['git config', '--no-verify', '--amend', '.env', '空 commit', '-i']) {
      expect(COMMIT_GUIDANCE).toContain(k)
    }
  })
  it('含「参照…风格」编排 + HEREDOC + add/update/fix 语义', () => {
    expect(COMMIT_GUIDANCE).toContain('风格')
    expect(COMMIT_GUIDANCE).toContain('HEREDOC')
    expect(COMMIT_GUIDANCE).toContain('add')
  })
  it('含 commit 后验证 git status', () => {
    expect(COMMIT_GUIDANCE).toContain('确认成功')
  })
  it('trailer = Co-Authored-By: deepcode <noreply@dirctable.com>', () => {
    expect(COMMIT_GUIDANCE).toContain('Co-Authored-By: deepcode <noreply@dirctable.com>')
  })
  it('commit body 不含 Generated with / 🤖（只进 PR）', () => {
    expect(COMMIT_GUIDANCE).not.toContain('Generated with')
    expect(COMMIT_GUIDANCE).not.toContain('🤖')
  })
  it('末尾纯调工具不输出文字', () => {
    expect(COMMIT_GUIDANCE).toContain('不要发送任何其它文字')
  })
})

describe('COMMIT_PUSH_PR_GUIDANCE', () => {
  it('含 force-push main 红线', () => {
    expect(COMMIT_PUSH_PR_GUIDANCE).toContain('force-push 到 main')
  })
  it('含 gh pr edit/create 二分', () => {
    expect(COMMIT_PUSH_PR_GUIDANCE).toContain('gh pr edit')
    expect(COMMIT_PUSH_PR_GUIDANCE).toContain('gh pr create')
  })
  it('PR body 模板含 Summary/Test plan/Changelog', () => {
    expect(COMMIT_PUSH_PR_GUIDANCE).toContain('## Summary')
    expect(COMMIT_PUSH_PR_GUIDANCE).toContain('## Test plan')
    expect(COMMIT_PUSH_PR_GUIDANCE).toContain('## Changelog')
  })
  it('PR trailer = 🤖 由 deepcode 生成', () => {
    expect(COMMIT_PUSH_PR_GUIDANCE).toContain('🤖 由 deepcode 生成')
  })
  it('含「分析所有 commit 不只最新」', () => {
    expect(COMMIT_PUSH_PR_GUIDANCE).toContain('不只是最新')
  })
  it('含 commit trailer 同款邮箱', () => {
    expect(COMMIT_PUSH_PR_GUIDANCE).toContain('Co-Authored-By: deepcode <noreply@dirctable.com>')
  })
})

describe('buildCommitContext', () => {
  it('用 <git-context> 包裹且含四段输出', () => {
    const c = buildCommitContext({ status: 'ST', diff: 'DF', branch: 'BR', log: 'LG' })
    expect(c.startsWith('<git-context>')).toBe(true)
    expect(c.trimEnd().endsWith('</git-context>')).toBe(true)
    expect(c).toContain('ST')
    expect(c).toContain('DF')
    expect(c).toContain('BR')
    expect(c).toContain('LG')
  })
})

describe('buildPrContext', () => {
  it('含 base diff 段与已存在 PR 段', () => {
    const c = buildPrContext({ status: 'ST', diff: 'DF', branch: 'BR', baseDiff: 'BD', existingPr: 'PR' })
    expect(c.startsWith('<git-context>')).toBe(true)
    expect(c).toContain('BD')
    expect(c).toContain('PR')
  })
})

describe('isEmptyDiff', () => {
  it('空串/纯空白→true', () => {
    expect(isEmptyDiff('')).toBe(true)
    expect(isEmptyDiff('   \n  ')).toBe(true)
  })
  it('有内容→false', () => {
    expect(isEmptyDiff(' M src/x.ts')).toBe(false)
  })
})

describe('resolveBaseBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('解析 symbolic-ref 末段', () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from('refs/remotes/origin/develop\n'))
    expect(resolveBaseBranch('/x')).toBe('develop')
  })
  it('execSync throw → 回退 main', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('no origin/HEAD') })
    expect(resolveBaseBranch('/x')).toBe('main')
  })
})
