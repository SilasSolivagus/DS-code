import fs from 'node:fs'
import path from 'node:path'

export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25600

const TRUNCATE_SUFFIX = '\n…（索引已截断，用 Read 查看 memory 目录全文）'

/** 按字节边界安全截断 s 到 ≤ maxBytes，丢弃末尾不完整的多字节 UTF-8 序列。 */
function byteSafeSlice(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= maxBytes) return s
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end-- // 回退到字符起始边界
  return buf.subarray(0, end).toString('utf8')
}

export function truncateEntrypoint(content: string): string {
  let out = content
  let truncated = false
  const lines = out.split('\n')
  if (lines.length > MAX_ENTRYPOINT_LINES) { out = lines.slice(0, MAX_ENTRYPOINT_LINES).join('\n'); truncated = true }
  // 预留 suffix 字节预算，保证「正文 + suffix」最终 ≤ 上限，且不裂多字节字符
  if (Buffer.byteLength(out, 'utf8') > MAX_ENTRYPOINT_BYTES) {
    const budget = MAX_ENTRYPOINT_BYTES - Buffer.byteLength(TRUNCATE_SUFFIX, 'utf8')
    out = byteSafeSlice(out, budget)
    truncated = true
  }
  return truncated ? out + TRUNCATE_SUFFIX : out
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
