import { spawnSync } from 'node:child_process'

/** 从后往前找第一条 role=assistant 且 content 为非空字符串的消息，返回其文本；找不到返回 null。纯函数、零副作用。 */
export function lastAssistantText(messages: any[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'assistant') continue
    if (typeof m.content !== 'string') continue
    if (m.content.trim() === '') continue
    return m.content
  }
  return null
}

/** 把 text 写入系统剪贴板（macOS pbcopy）。失败抛错，由接线层 catch。 */
export function copyToClipboard(text: string): void {
  const r = spawnSync('pbcopy', { input: text })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`pbcopy 退出码 ${r.status}`)
}
