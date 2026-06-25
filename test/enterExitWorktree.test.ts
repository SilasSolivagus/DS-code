// test/enterExitWorktree.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { ToolContext, WorktreeSessionState, WorktreeSession } from '../src/tools/types.js'
import { enterWorktreeTool } from '../src/tools/enterWorktree.js'
import { exitWorktreeTool } from '../src/tools/exitWorktree.js'

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-ew-'))
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@t')
  g('config', 'user.name', 't')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello')
  g('add', '.')
  g('commit', '-qm', 'init')
  return dir
}

function makeCtx(repo: string): { ctx: ToolContext; session: WorktreeSession; getCwd: () => string } {
  let cwd = repo
  let worktreeState: WorktreeSessionState | null = null
  const session: WorktreeSession = {
    get: () => worktreeState,
    set: s => { worktreeState = s },
  }
  const ctx: ToolContext = {
    cwd: () => cwd,
    setCwd: d => { cwd = d },
    signal: new AbortController().signal,
    fileState: new Map(),
    worktreeSession: session,
  }
  return { ctx, session, getCwd: () => cwd }
}

describe('EnterWorktree / ExitWorktree', () => {
  let repo: string
  beforeEach(() => { repo = initRepo() })
  afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }) })

  it('EnterWorktree: 切 cwd + 记状态；重复进拒绝', async () => {
    const { ctx, session } = makeCtx(repo)
    const result = await enterWorktreeTool.call({ name: 'w1' }, ctx)
    expect(typeof result).toBe('string')
    expect(result).toContain('worktree-w1')
    const state = session.get()
    expect(state).not.toBeNull()
    expect(ctx.cwd()).toBe(state!.worktreePath)
    expect(fs.existsSync(state!.worktreePath)).toBe(true)
    // 重复进 → 抛错
    await expect(enterWorktreeTool.call({ name: 'w2' }, ctx)).rejects.toThrow('已在 worktree 会话中')
  })

  it('ExitWorktree keep: 恢复 cwd、保留目录', async () => {
    const { ctx, session } = makeCtx(repo)
    await enterWorktreeTool.call({ name: 'keep1' }, ctx)
    const state = session.get()!
    const result = await exitWorktreeTool.call({ action: 'keep' }, ctx)
    expect(result).toContain('保留')
    expect(ctx.cwd()).toBe(repo)
    expect(session.get()).toBeNull()
    expect(fs.existsSync(state.worktreePath)).toBe(true) // dir kept
  })

  it('ExitWorktree remove 无改动: 删目录+分支', async () => {
    const { ctx, session } = makeCtx(repo)
    await enterWorktreeTool.call({ name: 'rm1' }, ctx)
    const state = session.get()!
    const result = await exitWorktreeTool.call({ action: 'remove' }, ctx)
    expect(result).toContain('删除')
    expect(ctx.cwd()).toBe(repo)
    expect(session.get()).toBeNull()
    expect(fs.existsSync(state.worktreePath)).toBe(false) // dir removed
    const branches = execFileSync('git', ['branch'], { cwd: repo }).toString()
    expect(branches).not.toContain('worktree-rm1')
  })

  it('ExitWorktree remove 有改动且无 discard_changes: 拒绝并列出', async () => {
    const { ctx, session } = makeCtx(repo)
    await enterWorktreeTool.call({ name: 'ch1' }, ctx)
    const state = session.get()!
    // Create an uncommitted file in the worktree
    fs.writeFileSync(path.join(state.worktreePath, 'dirty.txt'), 'change')
    const result = await exitWorktreeTool.call({ action: 'remove' }, ctx)
    expect(result).toContain('未提交文件')
    // session still active (refusal, not exited)
    expect(session.get()).not.toBeNull()
    expect(ctx.cwd()).toBe(state.worktreePath)
  })

  it('ExitWorktree remove 有改动 discard_changes:true: 删', async () => {
    const { ctx, session } = makeCtx(repo)
    await enterWorktreeTool.call({ name: 'ch2' }, ctx)
    const state = session.get()!
    fs.writeFileSync(path.join(state.worktreePath, 'dirty.txt'), 'change')
    const result = await exitWorktreeTool.call({ action: 'remove', discard_changes: true }, ctx)
    expect(result).toContain('删除')
    expect(session.get()).toBeNull()
    expect(fs.existsSync(state.worktreePath)).toBe(false)
  })

  it('ExitWorktree 无活跃会话: no-op 提示', async () => {
    const { ctx } = makeCtx(repo)
    const result = await exitWorktreeTool.call({ action: 'keep' }, ctx)
    expect(result).toContain('不在 worktree 会话中')
  })

  it('EnterWorktree 非 git: 报错', async () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-nogit-'))
    try {
      const { ctx } = makeCtx(nonGit)
      await expect(enterWorktreeTool.call({}, ctx)).rejects.toThrow('git 仓库')
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true })
    }
  })
})
