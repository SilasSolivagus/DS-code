import fs from 'node:fs'
import path from 'node:path'
import { readLastConsolidatedAt } from './consolidationLock.js'
import type { MemoryConfig } from '../../memdir/memoryConfig.js'
import { findGitRoot, sanitizeProjectKey } from '../../memdir/paths.js'

const RESCAN_MS = 600_000 // 时间过但会话不过：10min 内不再扫

export function countSessionsTouchedSince(sessionsDir: string, sinceMs: number, currentSessionFile: string, projectKey: string): number {
  let files: string[]
  try { files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl')) } catch { return 0 }
  const cur = path.basename(currentSessionFile)
  let n = 0
  for (const f of files) {
    if (f === cur) continue
    const fullPath = path.join(sessionsDir, f)
    try {
      // 读第一行，取 cwd，按项目键过滤（防跨项目会话触发本项目 dream）
      const firstLine = fs.readFileSync(fullPath, 'utf8').split('\n')[0]
      let meta: any
      try { meta = JSON.parse(firstLine) } catch { continue }
      if (!meta?.cwd) continue
      const key = sanitizeProjectKey(findGitRoot(meta.cwd) ?? meta.cwd)
      if (key !== projectKey) continue
      if (fs.statSync(fullPath).mtimeMs > sinceMs) n++
    } catch { /* skip */ }
  }
  return n
}

export interface DreamGateDeps {
  memdir: string; sessionsDir: string; currentSessionFile: string
  projectKey: string
  cfg: MemoryConfig['dream']; now: number; lastScanAt: number
  readLastAt?: (memdir: string) => number
  countSessions?: (sessionsDir: string, sinceMs: number, cur: string, projectKey: string) => number
}

export function checkDreamGates(d: DreamGateDeps): { pass: boolean; reason?: string } {
  const lastAt = (d.readLastAt ?? readLastConsolidatedAt)(d.memdir)
  const hoursSince = (d.now - lastAt) / 3600_000
  if (hoursSince < d.cfg.minHours) return { pass: false, reason: 'time' }
  if (d.now - d.lastScanAt < RESCAN_MS && d.lastScanAt > 0) return { pass: false, reason: 'rescan-throttle' }
  const n = (d.countSessions ?? countSessionsTouchedSince)(d.sessionsDir, lastAt, d.currentSessionFile, d.projectKey)
  if (n < d.cfg.minSessions) return { pass: false, reason: 'sessions' }
  return { pass: true }
}
