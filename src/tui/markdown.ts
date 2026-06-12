// 把 assistant 的 markdown 渲染成 ANSI 字符串（在 ink 之外渲染，作为 <Text> 内容插入）。
// 原则：终端不是浏览器——标题用粗体+§，代码块用高亮+左竖线，表格用 │ 对齐。渲染失败降级原文。
//
// 已知限制：CJK 全角字符在 padEnd 下表格列宽计算有偏差（每个汉字占 2 个终端格但 JS length=1）。
// 正确做法需引入 east-asian-width 之类依赖，v1 接受此偏差。
import { marked, type Token, type Tokens } from 'marked'
import { highlight } from 'cli-highlight'

const B = '\x1b[1m'    // 粗体
const DIM = '\x1b[2m'  // 暗色
const IT = '\x1b[3m'   // 斜体
const R = '\x1b[0m'    // 重置
const CODE = '\x1b[36m' // 行内码青色

function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, `${CODE}$1${R}`)
    .replace(/\*\*([^*]+)\*\*/g, `${B}$1${R}`)
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, `${IT}$1${R}`)
}

function codeBlock(tok: Tokens.Code): string {
  let body = tok.text
  try {
    body = highlight(tok.text, { language: tok.lang || 'plaintext', ignoreIllegals: true })
  } catch { /* 语言不支持时降级原文 */ }
  return body.split('\n').map(l => `${DIM}│${R} ${l}`).join('\n')
}

function table(tok: Tokens.Table): string {
  // marked@12: header 和 rows 的每个单元格是 { text: string, tokens: Token[] }
  const headerCells = tok.header.map(c => c.text)
  const dataRows = tok.rows.map(r => r.map(c => c.text))
  const allRows = [headerCells, ...dataRows]

  // 计算每列最大宽度（注意：CJK 全角字符会导致对齐偏差，见文件顶部说明）
  const widths = headerCells.map((_, i) =>
    Math.max(...allRows.map(r => (r[i] ?? '').length))
  )

  const line = (cells: string[], bold = false) =>
    cells
      .map((c, i) => (bold ? B : '') + (c ?? '').padEnd(widths[i]) + R)
      .join(` ${DIM}│${R} `)

  return [line(headerCells, true), ...dataRows.map(r => line(r))].join('\n')
}

function block(tok: Token): string {
  switch (tok.type) {
    case 'heading':
      return `${B}§ ${inline(tok.text)}${R}`

    case 'paragraph':
      return inline(tok.text)

    case 'code':
      return codeBlock(tok as Tokens.Code)

    case 'list': {
      const listTok = tok as Tokens.List
      return listTok.items.map(item => {
        const lines = item.text.split('\n')
        const first = `• ${inline(lines[0])}`
        if (lines.length === 1) return first
        return first + '\n  ' + inline(lines.slice(1).join('\n  '))
      }).join('\n')
    }

    case 'table':
      return table(tok as Tokens.Table)

    case 'blockquote': {
      const bqTok = tok as Tokens.Blockquote
      return bqTok.text.split('\n').map(l => `${DIM}▎${inline(l)}${R}`).join('\n')
    }

    case 'hr':
      return `${DIM}${'─'.repeat(40)}${R}`

    case 'space':
      return ''

    default:
      return 'raw' in tok ? (tok as { raw: string }).raw.trimEnd() : ''
  }
}

/** markdown → ANSI。任何异常降级返回原文。 */
export function renderMarkdown(md: string): string {
  try {
    const tokens = marked.lexer(md)
    return tokens.map(block).filter(s => s !== '').join('\n\n')
  } catch {
    return md
  }
}
