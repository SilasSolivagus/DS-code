// src/tui/toolArg.ts
// 纯函数：从工具调用的原始 JSON 参数串提取 CC 风格的主参数，用于 ⏺ Name(arg) 渲染。
// 无副作用（不碰 fs / ink），便于单测。
const MAX = 60

/** 折叠换行/控制字符为空格，截断到 60 字符（超出加 …）。*/
function clean(s: string): string {
  const collapsed = s.replace(/[\n\r\t]+/g, ' ').replace(/[\x00-\x1f]+/g, ' ').trim()
  return collapsed.length > MAX ? collapsed.slice(0, MAX) + '…' : collapsed
}

export function formatToolArg(name: string, desc: string): string {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(desc)
  } catch {
    // JSON 解析失败：降级为原文截断
    return clean(desc)
  }

  let raw: string
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
      raw = String(args.file_path ?? '')
      break
    case 'Bash':
      raw = String(args.command ?? '')
      break
    case 'Grep':
    case 'Glob':
      raw = String(args.pattern ?? '')
      break
    case 'Agent':
      raw = String(args.description ?? '')
      break
    case 'TodoWrite':
      raw = `${(args.todos as unknown[] | undefined)?.length ?? 0} 项`
      break
    default: {
      // 未知工具：取第一个字符串值字段
      const first = Object.values(args).find(v => typeof v === 'string')
      raw = typeof first === 'string' ? first : ''
    }
  }

  return clean(raw)
}
