// src/tui/diffPreview.ts
// 权限弹窗的 diff 预览：Edit → old/new 替换后全文 diff；Write → 现有内容 vs 新内容（新文件全 +）。
// 任何解析失败降级为 desc 原文。预览上限 40 行（超出截断并标注）。
import fs from 'node:fs'
import { diffLines, type Change } from 'diff'

export interface PreviewLine { sign: '+' | '-' | ' '; text: string }
export interface Preview { title: string; lines: PreviewLine[]; truncated: boolean }

const MAX = 40

function toLines(diff: Change[]): PreviewLine[] {
  const out: PreviewLine[] = []
  for (const part of diff) {
    const sign = part.added ? '+' : part.removed ? '-' : ' '
    for (const l of part.value.replace(/\n$/, '').split('\n')) {
      if (sign === ' ' && out.length && out[out.length - 1].sign === ' ') continue // 折叠连续上下文为 1 行
      out.push({ sign, text: l })
    }
  }
  return out
}

export function buildPreview(toolName: string, desc: string): Preview {
  try {
    const args = JSON.parse(desc)
    if (toolName === 'Edit' && args.file_path) {
      const cur = fs.readFileSync(args.file_path, 'utf8')
      const next = args.replace_all
        ? cur.replaceAll(args.old_string, args.new_string)
        : cur.replace(args.old_string, args.new_string)
      const lines = toLines(diffLines(cur, next) as Change[]).filter(l => l.sign !== ' ')
      return { title: `Edit ${args.file_path}`, lines: lines.slice(0, MAX), truncated: lines.length > MAX }
    }
    if (toolName === 'Write' && args.file_path) {
      let cur = ''
      try { cur = fs.readFileSync(args.file_path, 'utf8') } catch { /* 新文件 */ }
      const lines = toLines(diffLines(cur, args.content ?? '') as Change[]).filter(l => l.sign !== ' ')
      return { title: `Write ${args.file_path}`, lines: lines.slice(0, MAX), truncated: lines.length > MAX }
    }
    if (toolName === 'Bash' && args.command) {
      return { title: 'Bash', lines: String(args.command).split('\n').map(l => ({ sign: ' ' as const, text: l })), truncated: false }
    }
  } catch { /* 降级 */ }
  return { title: toolName, lines: [{ sign: ' ', text: desc.slice(0, 200) }], truncated: false }
}
