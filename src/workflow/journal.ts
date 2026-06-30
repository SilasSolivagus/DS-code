// src/workflow/journal.ts
import { appendFile, readFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { JournalRecord } from './types.js'

export class LocalFileJournal {
  constructor(private path: string) {}
  async append(r: JournalRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await appendFile(this.path, JSON.stringify(r) + '\n')
  }
  async load(): Promise<JournalRecord[]> {
    let raw: string
    try { raw = await readFile(this.path, 'utf8') } catch { return [] }
    return raw.split('\n').filter(Boolean).map(l => JSON.parse(l) as JournalRecord)
  }
}

/** 稳定 opts 键：递归按键排序后 JSON。 */
export function optsKeyOf(opts: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as object).sort().map(k => [k, sort((v as Record<string, unknown>)[k])]))
    }
    return v
  }
  return JSON.stringify(sort(opts ?? {}))
}

/** resume 缓存查询：同结构化 key 的 workflow_agent 记录，prompt+optsKey 全等 → 命中。
 *  key 由 agent() 在编排树中的确定性位置（路径 + 同路径序号）派生，
 *  并发完成顺序不影响匹配（多 stage pipeline 的 fan-out 下也稳定）。 */
export function cachedAgent(records: JournalRecord[], key: string, prompt: string, optsKey: string): { hit: boolean; result?: unknown } {
  const rec = records.find(r => r.type === 'workflow_agent' && r.key === key)
  if (rec && rec.type === 'workflow_agent' && rec.prompt === prompt && rec.optsKey === optsKey) {
    return { hit: true, result: rec.result }
  }
  return { hit: false }
}
