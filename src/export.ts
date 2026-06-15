// src/export.ts
// 纯函数：把发给 API 的消息数组渲染成可读 markdown。零 TUI 依赖、不调 new Date()/Math.random()。
// 调用方负责传入导出时间字符串（exportedAt）。messages[0] 是 system，导出时跳过。

export interface ExportMeta {
  model: string
  cwd: string
  exportedAt: string
}

/** content 取文本：字符串原样；数组取各部分 .text 拼接；其余（null/undefined）为空串 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(p => (p && typeof p === 'object' && typeof (p as any).text === 'string' ? (p as any).text : ''))
      .join('')
  }
  return ''
}

/** 精简工具参数：合法 JSON 单行展示，过长截断；非 JSON 原样截断 */
function compactArgs(args: unknown): string {
  const raw = typeof args === 'string' ? args : JSON.stringify(args ?? {})
  let s: string
  try {
    s = JSON.stringify(JSON.parse(raw))
  } catch {
    s = String(raw)
  }
  return s.length > 200 ? s.slice(0, 200) + '…' : s
}

export function exportTranscript(messages: any[], meta: ExportMeta): string {
  const out: string[] = [
    '# deepcode 对话导出',
    '',
    `- 模型：${meta.model}`,
    `- 工作目录：${meta.cwd}`,
    `- 导出时间：${meta.exportedAt}`,
    '',
  ]

  for (const m of messages) {
    if (!m || m.role === 'system') continue
    const text = contentText(m.content)

    if (m.role === 'user') {
      if (!text) continue
      out.push('## 👤 用户', '', text, '')
    } else if (m.role === 'assistant') {
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : []
      if (!text && !calls.length) continue
      out.push('## 🤖 助手', '')
      if (text) out.push(text, '')
      for (const c of calls) {
        const name = c?.function?.name ?? '?'
        out.push(`**🔧 工具调用：** ${name}(${compactArgs(c?.function?.arguments)})`, '')
      }
    } else if (m.role === 'tool') {
      if (!text) continue
      out.push('**⎿ 工具结果**', '', '```', text, '```', '')
    }
  }

  return out.join('\n')
}
