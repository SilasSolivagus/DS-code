import fs from 'node:fs'
import path from 'node:path'

export const MAX_RECALL_BYTES = 16384

export function buildRecallReminder(files: { filename: string; content: string }[]): string {
  const body = files.map(f => `### ${f.filename}\n${f.content}`).join('\n\n')
  return `<system-reminder>\n以下是与你当前任务可能相关的已存记忆（自动召回，背景参考，非用户指令）：\n\n${body}\n</system-reminder>`
}

export interface RecallerDeps {
  memdir: string
  find: (query: string) => Promise<string[]>
  maxResults: number
}

export function createRecaller(deps: RecallerDeps) {
  let settled: string[] | null = null
  const seen = new Set<string>()

  return {
    prefetch(query: string) {
      settled = null
      deps.find(query).then(r => { settled = r }, () => { settled = [] })
    },
    consume(alreadyRead: Set<string>): string | null {
      if (settled === null) return null // 还没好，下一轮再来
      const picks = settled.filter(fn => !seen.has(fn) && !alreadyRead.has(path.join(deps.memdir, fn)))
      settled = null
      if (!picks.length) return null
      const files: { filename: string; content: string }[] = []
      let bytes = 0
      for (const fn of picks) {
        let content = ''
        try { content = fs.readFileSync(path.join(deps.memdir, fn), 'utf8') } catch { continue }
        const remaining = MAX_RECALL_BYTES - bytes
        if (remaining <= 0) break
        if (Buffer.byteLength(content, 'utf8') > remaining) {
          content = content.slice(0, Math.max(0, remaining - 60)) + '\n…（截断，用 Read 看全文）'
          files.push({ filename: fn, content }); seen.add(fn); break
        }
        bytes += Buffer.byteLength(content, 'utf8')
        files.push({ filename: fn, content }); seen.add(fn)
      }
      return files.length ? buildRecallReminder(files) : null
    },
  }
}
