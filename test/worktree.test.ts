// test/worktree.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { resolveGitRoot, createWorktree, worktreeChanges, removeWorktree } from '../src/worktree.js'

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-wt-'))
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello')
  g('add', '.'); g('commit', '-qm', 'init')
  return dir
}

describe('worktree', () => {
  let repo: string
  beforeEach(() => { repo = initRepo() })
  afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }) })

  it('resolveGitRoot: git 仓库回根、非 git 回 null', async () => {
    expect(await resolveGitRoot(repo)).toBe(fs.realpathSync(repo))
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-nogit-'))
    expect(await resolveGitRoot(nonGit)).toBeNull()
    fs.rmSync(nonGit, { recursive: true, force: true })
  })

  it('createWorktree: 路径/分支/headCommit 正确', async () => {
    const h = await createWorktree(repo, 'feat1')
    expect(h.worktreePath).toBe(path.join(repo, '.deepcode', 'worktrees', 'feat1'))
    expect(h.worktreeBranch).toBe('worktree-feat1')
    expect(h.headCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(fs.existsSync(path.join(h.worktreePath, 'a.txt'))).toBe(true)
  })

  it('worktreeChanges: 干净=0，改文件→changedFiles>0，提交→commits>0', async () => {
    const h = await createWorktree(repo, 'feat2')
    expect(await worktreeChanges(h.worktreePath, h.headCommit)).toEqual({ changedFiles: 0, commits: 0 })
    fs.writeFileSync(path.join(h.worktreePath, 'b.txt'), 'x')
    expect((await worktreeChanges(h.worktreePath, h.headCommit)).changedFiles).toBeGreaterThan(0)
    const g = (...a: string[]) => execFileSync('git', a, { cwd: h.worktreePath })
    g('add', '.'); g('commit', '-qm', 'c2')
    expect((await worktreeChanges(h.worktreePath, h.headCommit)).commits).toBe(1)
  })

  it('removeWorktree: 删目录+分支，幂等', async () => {
    const h = await createWorktree(repo, 'feat3')
    await removeWorktree(h)
    expect(fs.existsSync(h.worktreePath)).toBe(false)
    const branches = execFileSync('git', ['branch'], { cwd: repo }).toString()
    expect(branches).not.toContain('worktree-feat3')
    await expect(removeWorktree(h)).resolves.toBeUndefined() // 幂等不抛
  })

  it('createWorktree sparse: 只检出指定路径', async () => {
    const g = (...a: string[]) => execFileSync('git', a, { cwd: repo })
    fs.mkdirSync(path.join(repo, 'pkg')); fs.writeFileSync(path.join(repo, 'pkg/x.txt'), '1')
    fs.mkdirSync(path.join(repo, 'other')); fs.writeFileSync(path.join(repo, 'other/y.txt'), '2')
    g('add', '.'); g('commit', '-qm', 'dirs')
    const h = await createWorktree(repo, 'sp', { sparsePaths: ['pkg'] })
    expect(fs.existsSync(path.join(h.worktreePath, 'pkg/x.txt'))).toBe(true)
    expect(fs.existsSync(path.join(h.worktreePath, 'other/y.txt'))).toBe(false)
  })

  it('createWorktree symlink: 目录变软链', async () => {
    fs.mkdirSync(path.join(repo, 'node_modules'))
    fs.writeFileSync(path.join(repo, 'node_modules/.keep'), '')
    const h = await createWorktree(repo, 'sl', { symlinkDirectories: ['node_modules'] })
    expect(fs.lstatSync(path.join(h.worktreePath, 'node_modules')).isSymbolicLink()).toBe(true)
  })
})
