// 把 assistant 的 markdown 渲染成 ANSI 字符串（在 ink 之外渲染，作为 <Text> 内容插入）。
// 原则：终端不是浏览器——标题用粗体+§，代码块用高亮+左竖线，表格用 │ 对齐。渲染失败降级原文。
import { marked, type Token, type Tokens } from 'marked'
import { highlight, supportsLanguage } from 'cli-highlight'
import stringWidth from 'string-width'

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
    const lang = tok.lang && supportsLanguage(tok.lang) ? tok.lang : 'plaintext'
    body = highlight(tok.text, { language: lang, ignoreIllegals: true })
  } catch { /* 语言不支持时降级原文 */ }
  return body.split('\n').map(l => `${DIM}│${R} ${l}`).join('\n')
}

function table(tok: Tokens.Table): string {
  // marked@12: header 和 rows 的每个单元格是 { text: string, tokens: Token[] }
  const headerCells = tok.header.map(c => c.text)
  const dataRows = tok.rows.map(r => r.map(c => c.text))
  const allRows = [headerCells, ...dataRows]

  // 计算每列最大宽度（用 stringWidth 处理 CJK 全角字符）
  const widths = headerCells.map((_, i) =>
    Math.max(...allRows.map(r => stringWidth(r[i] ?? '')))
  )

  const padToWidth = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - stringWidth(s)))

  // 表格单元格故意跳过 inline 样式：ANSI 转义码会破坏 padEnd 宽度计算。
  const line = (cells: string[], bold = false) =>
    cells
      .map((c, i) => (bold ? B : '') + padToWidth(c ?? '', widths[i]) + R)
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
      return listTok.items.map((item, idx) => {
        const marker = listTok.ordered ? `${(listTok.start || 1) + idx}.` : '•'
        const lines = item.text.split('\n')
        const first = `${marker} ${inline(lines[0])}`
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
