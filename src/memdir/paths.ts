import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const MAX_KEY_LEN = 200

export function sanitizeProjectKey(s: string): string {
  const clean = s.replace(/[^a-zA-Z0-9]/g, '-')
  if (clean.length <= MAX_KEY_LEN) return clean
  const hash = crypto.createHash('sha1').update(s).digest('hex').slice(0, 12)
  return clean.slice(0, MAX_KEY_LEN) + '-' + hash
}

/** 向上找含 .git（目录或文件，支持 worktree）的目录，realpath 归一；找不到返回 null。 */
export function findGitRoot(cwd: string): string | null {
  let dir = path.resolve(cwd)
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return fs.realpathSync(dir)
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function projectsBase(home: string): string {
  return path.join(home, '.deepcode', 'projects')
}

/** memdir：项目键用 git root（同 repo 多 worktree 共享），非 git fallback cwd。 */
export function memdirFor(cwd: string, home: string = os.homedir()): string {
  const key = sanitizeProjectKey(findGitRoot(cwd) ?? path.resolve(cwd))
  return path.join(projectsBase(home), key, 'memory')
}

/** session-memory：项目键用 cwd（非 git root），+ sessionId 子目录 + summary.md。 */
export function sessionMemoryPathFor(cwd: string, sessionId: string, home: string = os.homedir()): string {
  const key = sanitizeProjectKey(path.resolve(cwd))
  return path.join(projectsBase(home), key, sessionId, 'session-memory', 'summary.md')
}
