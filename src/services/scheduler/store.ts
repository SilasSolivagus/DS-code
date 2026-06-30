import fs from 'node:fs'
import path from 'node:path'
import type { CronJob } from './types.js'
import { JITTER } from './cron.js'

const LOCK_TTL_MS = 90_000

export function storePathFor(cwd: string): string {
  return path.join(cwd, '.deepcode', 'scheduled_tasks.json')
}
export function lockPathFor(cwd: string): string {
  return path.join(cwd, '.deepcode', 'scheduled_tasks.lock')
}

export function saveDurable(cwd: string, jobs: CronJob[]): void {
  const file = storePathFor(cwd)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const durable = jobs.filter(j => j.durable)
  fs.writeFileSync(file, JSON.stringify({ version: 1, jobs: durable }, null, 2))
}

/** 读 durable：剔除 age-out 的 recurring；non-recurring 已过期者归 missedOneShots 供 catch-up。损坏→空。 */
export function loadDurable(cwd: string, now = Date.now()): { jobs: CronJob[]; missedOneShots: CronJob[] } {
  let raw: any
  try {
    raw = JSON.parse(fs.readFileSync(storePathFor(cwd), 'utf8'))
  } catch {
    return { jobs: [], missedOneShots: [] }
  }
  const all: CronJob[] = Array.isArray(raw?.jobs) ? raw.jobs : []
  const jobs: CronJob[] = []
  const missedOneShots: CronJob[] = []
  for (const j of all) {
    if (j.recurring) {
      if ((now - j.createdAt) >= JITTER.recurringMaxAgeMs) continue // age-out
      jobs.push(j)
    } else {
      if (j.nextFireAt < now) missedOneShots.push(j)
      else jobs.push(j)
    }
  }
  return { jobs, missedOneShots }
}

export function acquireLock(cwd: string, pid = process.pid, now = Date.now()): boolean {
  const file = lockPathFor(cwd)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (cur.pid === pid) { /* 本进程已持有 */ }
    else if (now - cur.at < LOCK_TTL_MS) return false // 新鲜锁，他人持有
  } catch { /* 无锁/坏锁 → 可获 */ }
  fs.writeFileSync(file, JSON.stringify({ pid, at: now }))
  return true
}

export function releaseLock(cwd: string): void {
  try { fs.unlinkSync(lockPathFor(cwd)) } catch { /* 尽力 */ }
}
