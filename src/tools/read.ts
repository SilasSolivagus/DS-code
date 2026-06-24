// src/tools/read.ts
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import type { Tool } from './types.js'
import { parseNotebook, formatNotebookForRead } from '../notebook.js'

const MAX_LINES = 2000
const MAX_LINE_CHARS = 2000

const schema = z.object({
  file_path: z.string().describe('要读取的文件路径（建议绝对路径）'),
  offset: z.number().int().min(1).optional().describe('起始行号（从 1 开始）'),
  limit: z.number().int().min(1).optional().describe('最多读取的行数'),
})

export const readTool: Tool<typeof schema> = {
  name: 'Read',
  description:
    '读取文件内容，输出带行号（行号\\t内容）。大文件用 offset/limit 分段读取。编辑任何文件前必须先用本工具读取它。',
  inputSchema: schema,
  isReadOnly: true,
  needsPermission: () => false,
  deniablePaths: (input, cwd) => [path.resolve(cwd, input.file_path)],
  workspacePaths: (input, cwd) => [path.resolve(cwd, input.file_path)],
  async call(input, ctx) {
    const p = path.resolve(ctx.cwd(), input.file_path)
    let stat: fs.Stats
    try {
      stat = fs.statSync(p)
    } catch {
      return `错误：文件不存在：${p}。请用 Glob 确认正确路径。`
    }
    if (stat.isDirectory()) return `错误：${p} 是目录。请用 Glob 列出其中的文件。`
    if (p.endsWith('.ipynb')) {
      const nb = parseNotebook(fs.readFileSync(p, 'utf8'))
      if (nb) {
        ctx.fileState.set(p, fs.statSync(p).mtimeMs)
        return formatNotebookForRead(nb)
      }
      // 解析失败 → 落到下方纯文本读取（优雅回退）
    }
    const lines = fs.readFileSync(p, 'utf8').split('\n')
    if (input.offset !== undefined && input.offset - 1 >= lines.length) {
      return `错误：offset ${input.offset} 超出文件总行数 ${lines.length}。`
    }
    const start = (input.offset ?? 1) - 1
    const limit = Math.min(input.limit ?? MAX_LINES, MAX_LINES)
    const slice = lines.slice(start, start + limit)
    const newStat = fs.statSync(p)
    ctx.fileState.set(p, newStat.mtimeMs)
    const body = slice
      .map((l, i) => {
        const text = l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + '…[行截断]' : l
        return `${start + i + 1}\t${text}`
      })
      .join('\n')
    const note =
      start + slice.length < lines.length
        ? `\n[已截断：文件共 ${lines.length} 行，本次显示第 ${start + 1}-${start + slice.length} 行，用 offset 继续读取]`
        : ''
    return body + note
  },
}
