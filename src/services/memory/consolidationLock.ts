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
  // [I-1] 拆两个 try：stat 单独保存 priorMtime，读内容失败不清零
  try {
    const stat = fs.statSync(p)
    priorMtime = stat.mtimeMs
    let canAcquire = false
    try {
      const pid = parseInt(fs.readFileSync(p, 'utf8').trim(), 10)
      // PID 有效且存活且锁新鲜 → 拒绝
      if (Number.isFinite(pid) && isPidAlive(pid) && now - stat.mtimeMs < FRESH_MS) return null
    } catch {
      // 读内容/解析失败 → 视为可抢占，priorMtime 保留 stat 值
      canAcquire = true
    }
    void canAcquire
  } catch {
    // stat 失败 → 无锁，priorMtime=0
    priorMtime = 0
  }
  try {
    fs.mkdirSync(memdir, { recursive: true })
    fs.writeFileSync(p, String(process.pid))
    return priorMtime
  } catch (e: unknown) {
    // [I-2] 写锁失败可见性
    console.error('[memory] autoDream 取锁写入失败：' + ((e instanceof Error) ? e.message : e))
    return null
  }
}

export function rollbackConsolidationLock(memdir: string, priorMtime: number): void {
  const p = lockPath(memdir)
  try {
    if (priorMtime === 0) { fs.rmSync(p, { force: true }); return }
    fs.writeFileSync(p, '')
    fs.utimesSync(p, new Date(priorMtime), new Date(priorMtime))
  } catch { /* 忽略 */ }
}
