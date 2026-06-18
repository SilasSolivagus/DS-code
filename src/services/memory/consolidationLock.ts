import fs from 'node:fs'
import path from 'node:path'

const LOCK = '.consolidate-lock'
const FRESH_MS = 3600_000

function lockPath(memdir: string) { return path.join(memdir, LOCK) }

export function readLastConsolidatedAt(memdir: string): number {
  try { return fs.statSync(lockPath(memdir)).mtimeMs } catch { return 0 }
}

function pidAliveDefault(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

export function tryAcquireConsolidationLock(memdir: string, now: number, isPidAlive: (pid: number) => boolean = pidAliveDefault): number | null {
  const p = lockPath(memdir)
  let priorMtime = 0
  try {
    const stat = fs.statSync(p)
    priorMtime = stat.mtimeMs
    const pid = parseInt(fs.readFileSync(p, 'utf8').trim(), 10)
    if (Number.isFinite(pid) && isPidAlive(pid) && now - stat.mtimeMs < FRESH_MS) return null
  } catch { priorMtime = 0 }
  try {
    fs.mkdirSync(memdir, { recursive: true })
    fs.writeFileSync(p, String(process.pid))
    return priorMtime
  } catch { return null }
}

export function rollbackConsolidationLock(memdir: string, priorMtime: number): void {
  const p = lockPath(memdir)
  try {
    if (priorMtime === 0) { fs.rmSync(p, { force: true }); return }
    fs.writeFileSync(p, '')
    fs.utimesSync(p, new Date(priorMtime), new Date(priorMtime))
  } catch { /* 忽略 */ }
}
