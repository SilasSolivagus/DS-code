import path from 'node:path'

export function shouldExtractByThrottle(turnsSinceLast: number, everyTurns: number, isTrailing: boolean): boolean {
  if (isTrailing) return true
  return turnsSinceLast >= Math.max(1, everyTurns)
}

/** 取 turnId > cursor 的首个 user 消息起到数组末尾。无则返回全部（首次提取）。 */
export function messagesSince(messages: any[], turnIds: (number | undefined)[], cursorTurnId: number): any[] {
  let start = -1
  for (let i = 0; i < messages.length; i++) {
    const t = turnIds[i]
    if (typeof t === 'number' && t > cursorTurnId) { start = i; break }
  }
  return start < 0 ? (cursorTurnId <= 0 ? messages.slice() : []) : messages.slice(start)
}

/** 区间消息里是否有写 memdir 的 tool_call（MemWrite/MemEdit 恒算；Write/Edit 看路径前缀）。 */
export function hasMemoryWritesSince(messages: any[], memdir: string): boolean {
  const root = path.resolve(memdir)
  for (const m of messages) {
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue
    for (const c of m.tool_calls) {
      const name = c?.function?.name
      if (name === 'MemWrite' || name === 'MemEdit') return true
      if (name === 'Write' || name === 'Edit') {
        try {
          const fp = JSON.parse(c.function.arguments)?.file_path
          if (typeof fp === 'string' && path.resolve(fp).startsWith(root)) return true
        } catch { /* 忽略 */ }
      }
    }
  }
  return false
}
