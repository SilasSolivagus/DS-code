// src/worktree.ts —— git worktree CLI 底座（execFile，无第三方 git 库）。全函数 fail-safe。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
const exec = promisify(execFile)

export interface WorktreeConfig { symlinkDirectories?: string[]; sparsePaths?: string[] }
export interface WorktreeHandle { worktreePath: string; worktreeBranch: string; headCommit: string; gitRoot: string; hookBased?: boolean }

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await exec('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 })
    return { stdout, stderr, code: 0 }
  } catch (e: any) {
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? String(e?.message ?? e), code: typeof e?.code === 'number' ? e.code : 1 }
  }
}

/** 主工作树根（从 linked worktree 内也回主仓主工作树，使嵌套 worktree 不层层嵌套）；非 git 返回 null。 */
export async function resolveGitRoot(cwd: string): Promise<string | null> {
  const top = await git(['rev-parse', '--show-toplevel'], cwd)
  if (top.code !== 0) return null
  const common = await git(['rev-parse', '--git-common-dir'], cwd)
  if (common.code === 0 && common.stdout.trim()) {
    const commonDir = path.resolve(cwd, common.stdout.trim())
    if (path.basename(commonDir) === '.git') return fs.realpathSync(path.dirname(commonDir))
  }
  return fs.realpathSync(top.stdout.trim())
}

async function resolveBase(gitRoot: string): Promise<string> {
  const origin = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], gitRoot)
  if (origin.code === 0 && origin.stdout.trim()) return origin.stdout.trim()
  const cur = await git(['rev-parse', '--abbrev-ref', 'HEAD'], gitRoot)
  const c = cur.stdout.trim()
  if (cur.code === 0 && c && c !== 'HEAD') return c
  return 'HEAD'
}

function applyWorktreeConfig(gitRoot: string, worktreePath: string, cfg: WorktreeConfig): void {
  const srcLocal = path.join(gitRoot, '.deepcode', 'settings.local.json')
  if (fs.existsSync(srcLocal)) {
    try {
      const dstDir = path.join(worktreePath, '.deepcode'); fs.mkdirSync(dstDir, { recursive: true })
      fs.copyFileSync(srcLocal, path.join(dstDir, 'settings.local.json'))
    } catch { /* 非致命 */ }
  }
  for (const dir of cfg.symlinkDirectories ?? []) {
    const target = path.join(gitRoot, dir)
    if (!fs.existsSync(target)) continue
    const link = path.join(worktreePath, dir)
    try {
      fs.rmSync(link, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(link), { recursive: true })
      fs.symlinkSync(target, link)
    } catch { /* 非致命 */ }
  }
}

/** 建 worktree：git worktree add -b worktree-<name> <root>/.deepcode/worktrees/<name> <base>。 */
export async function createWorktree(gitRoot: string, name: string, cfg?: WorktreeConfig): Promise<WorktreeHandle> {
  const worktreePath = path.join(gitRoot, '.deepcode', 'worktrees', name)
  const worktreeBranch = `worktree-${name}`
  const base = await resolveBase(gitRoot)
  await git(['branch', '-D', worktreeBranch], gitRoot) // 清旧同名分支（幂等）
  const sparse = cfg?.sparsePaths?.length ? cfg.sparsePaths : null
  const addArgs = ['worktree', 'add', ...(sparse ? ['--no-checkout'] : []), '-b', worktreeBranch, worktreePath, base]
  const add = await git(addArgs, gitRoot)
  if (add.code !== 0) throw new Error(`创建 worktree 失败：${add.stderr.trim()}`)
  if (sparse) {
    const sc = await git(['sparse-checkout', 'set', '--cone', '--', ...sparse], worktreePath)
    if (sc.code !== 0) { await git(['worktree', 'remove', '--force', worktreePath], gitRoot); throw new Error(`sparse-checkout 失败：${sc.stderr.trim()}`) }
    await git(['checkout', 'HEAD'], worktreePath)
  }
  const head = await git(['rev-parse', 'HEAD'], worktreePath)
  const headCommit = head.code === 0 ? head.stdout.trim() : ''
  if (cfg) applyWorktreeConfig(gitRoot, worktreePath, cfg)
  return { worktreePath, worktreeBranch, headCommit, gitRoot }
}

/** 改动检测：status --porcelain 非空文件数 + rev-list <headCommit>..HEAD 领先提交数。 */
export async function worktreeChanges(worktreePath: string, headCommit: string): Promise<{ changedFiles: number; commits: number }> {
  const status = await git(['status', '--porcelain'], worktreePath)
  const changedFiles = status.code === 0 ? status.stdout.split('\n').filter(l => l.trim() !== '').length : 0
  let commits = 0
  if (headCommit) {
    const rev = await git(['rev-list', '--count', `${headCommit}..HEAD`], worktreePath)
    commits = rev.code === 0 ? (parseInt(rev.stdout.trim(), 10) || 0) : 0
  }
  return { changedFiles, commits }
}

/** 删 worktree + 分支；吞「已删/不存在」错误（幂等）。 */
export async function removeWorktree(h: Pick<WorktreeHandle, 'worktreePath' | 'worktreeBranch' | 'gitRoot'>): Promise<void> {
  await git(['worktree', 'remove', '--force', h.worktreePath], h.gitRoot)
  await git(['branch', '-D', h.worktreeBranch], h.gitRoot)
}
