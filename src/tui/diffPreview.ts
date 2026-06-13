// src/tui/diffPreview.ts
// 权限弹窗的 diff 预览：Edit → old/new 替换后全文 diff；Write → 现有内容 vs 新内容（新文件全 +）。
// 任何解析失败降级为 desc 原文。预览上限 40 行（超出截断并标注）。
import fs from 'node:fs'
import { diffLines, type Change } from 'diff'
import { sanitize } from '../text.js'

export interface PreviewLine { sign: '+' | '-' | ' '; text: string }
export interface Preview { title: string; lines: PreviewLine[]; truncated: boolean }

const MAX = 40

function toLines(diff: Change[]): PreviewLine[] {
  // 调用方在 toLines 之后立即过滤掉 sign===' ' 的行，
  // 因此这里的"折叠连续上下文"分支永远不会执行，直接按原样输出即可。
  const out: PreviewLine[] = []
  for (const part of diff) {
    const sign = part.added ? '+' : part.removed ? '-' : ' '
    for (const l of part.value.replace(/\n$/, '').split('\n')) {
      out.push({ sign, text: sanitize(l) })
    }
  }
  return out
}

export function buildPreview(toolName: string, desc: string): Preview {
  try {
    const args = JSON.parse(desc)
    if (toolName === 'Edit' && args.file_path) {
      const cur = fs.readFileSync(args.file_path, 'utf8')
      // 使用与 edit.ts 相同的字面量替换逻辑，避免 $& $$ 等特殊替换语义影响预览。
      let next: string
      if (args.replace_all) {
        next = cur.split(args.old_string).join(args.new_string)
      } else {
        const idx = cur.indexOf(args.old_string)
        if (idx === -1) {
          next = cur
        } else {
          next = cur.slice(0, idx) + args.new_string + cur.slice(idx + (args.old_string as string).length)
        }
      }
      const lines = toLines(diffLines(cur, next) as Change[]).filter(l => l.sign !== ' ')
      if (lines.length === 0) {
        return {
          title: `Edit ${args.file_path}`,
          lines: [{ sign: ' ', text: '（无差异——old_string 未命中或内容相同，工具将报错或无效果）' }],
          truncated: false,
        }
      }
      return { title: `Edit ${args.file_path}`, lines: lines.slice(0, MAX), truncated: lines.length > MAX }
    }
    if (toolName === 'Write' && args.file_path) {
      let cur = ''
      try { cur = fs.readFileSync(args.file_path, 'utf8') } catch { /* 新文件 */ }
      const lines = toLines(diffLines(cur, args.content ?? '') as Change[]).filter(l => l.sign !== ' ')
      if (lines.length === 0) {
        return {
          title: `Write ${args.file_path}`,
          lines: [{ sign: ' ', text: '（无差异——old_string 未命中或内容相同，工具将报错或无效果）' }],
          truncated: false,
        }
      }
      return { title: `Write ${args.file_path}`, lines: lines.slice(0, MAX), truncated: lines.length > MAX }
    }
    if (toolName === 'Bash' && args.command) {
      return {
        title: 'Bash',
        lines: String(args.command).split('\n').map(l => ({ sign: ' ' as const, text: sanitize(l) })),
        truncated: false,
      }
    }
  } catch { /* 降级 */ }
  return { title: toolName, lines: [{ sign: ' ', text: sanitize(desc.slice(0, 200)) }], truncated: false }
}
