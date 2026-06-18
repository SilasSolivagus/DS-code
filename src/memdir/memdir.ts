import fs from 'node:fs'
import path from 'node:path'

export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25600

export function truncateEntrypoint(content: string): string {
  let out = content
  const lines = out.split('\n')
  let truncated = false
  if (lines.length > MAX_ENTRYPOINT_LINES) { out = lines.slice(0, MAX_ENTRYPOINT_LINES).join('\n'); truncated = true }
  while (Buffer.byteLength(out, 'utf8') > MAX_ENTRYPOINT_BYTES) {
    out = out.slice(0, Math.floor(out.length * 0.9)); truncated = true
  }
  return truncated ? out + '\n…（索引已截断，用 Read 查看 memory 目录全文）' : out
}

/** 读 memdir/MEMORY.md 注入系统提示的 `## 记忆索引` 段。会话启动调一次，保持静态。 */
export function loadMemoryPrompt(memdir: string): string {
  let body = ''
  try { body = fs.readFileSync(path.join(memdir, 'MEMORY.md'), 'utf8').trim() } catch { /* 缺失 */ }
  const inner = body
    ? truncateEntrypoint(body)
    : '（暂无记忆。沉淀的记忆会自动出现在这里；每条记忆是一个带 frontmatter 的 .md 文件，指针记入 MEMORY.md。）'
  return `## 记忆索引\n${inner}`
}
