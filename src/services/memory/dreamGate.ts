import fs from 'node:fs'
import path from 'node:path'
import { readLastConsolidatedAt } from './consolidationLock.js'
import type { MemoryConfig } from '../../memdir/memoryConfig.js'

const RESCAN_MS = 600_000 // 时间过但会话不过：10min 内不再扫

export function countSessionsTouchedSince(sessionsDir: string, sinceMs: number, currentSessionFile: string): number {
  let files: string[]
  try { files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl')) } catch { return 0 }
  const cur = path.basename(currentSessionFile)
  let n = 0
  for (const f of files) {
    if (f === cur) continue
    try { if (fs.statSync(path.join(sessionsDir, f)).mtimeMs > sinceMs) n++ } catch { /* skip */ }
  }
  return n
}

export interface DreamGateDeps {
  memdir: string; sessionsDir: string; currentSessionFile: string
  cfg: MemoryConfig['dream']; now: number; lastScanAt: number
  readLastAt?: (memdir: string) => number
  countSessions?: (sessionsDir: string, sinceMs: number, cur: string) => number
}

export function checkDreamGates(d: DreamGateDeps): { pass: boolean; reason?: string } {
  const lastAt = (d.readLastAt ?? readLastConsolidatedAt)(d.memdir)
  const hoursSince = (d.now - lastAt) / 3600_000
  if (hoursSince < d.cfg.minHours) return { pass: false, reason: 'time' }
  if (d.now - d.lastScanAt < RESCAN_MS && d.lastScanAt > 0) return { pass: false, reason: 'rescan-throttle' }
  const n = (d.countSessions ?? countSessionsTouchedSince)(d.sessionsDir, lastAt, d.currentSessionFile)
  if (n < d.cfg.minSessions) return { pass: false, reason: 'sessions' }
  return { pass: true }
}
