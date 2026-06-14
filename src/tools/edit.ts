// src/tools/edit.ts
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import type { Tool, ToolContext } from './types.js'

const schema = z.object({
  file_path: z.string().describe('要编辑的文件路径'),
  old_string: z.string().min(1).describe('要被替换的原文（必须与文件内容逐字符一致，含缩进与换行；不能为空）'),
  new_string: z.string().describe('替换后的新文本'),
  replace_all: z.boolean().optional().describe('替换所有出现处；默认 false（要求 old_string 在文件中唯一）'),
})

/** read-before-edit 闸门：必须 Read 过且此后未被外部修改。通过返回 null，否则返回给模型的错误信息。Write 覆盖已存在文件时复用。 */
export function checkFileState(p: string, ctx: ToolContext): string | null {
  const recorded = ctx.fileState.get(p)
  if (recorded === undefined) return `错误：编辑前必须先用 Read 工具读取 ${p}。`
  let stat: fs.Stats
  try {
    stat = fs.statSync(p)
  } catch {
    return `错误：文件不存在：${p}。`
  }
  if (stat.mtimeMs !== recorded) {
    return `错误：${p} 在你读取之后被外部修改过，请重新用 Read 读取最新内容再编辑。`
  }
  return null
}

export const editTool: Tool<typeof schema> = {
  name: 'Edit',
  description:
    '对文件做精确字符串替换。old_string 必须与文件内容逐字符一致（含缩进与换行）且默认要求唯一；不唯一时请提供更长的包含上下文的片段，或用 replace_all 全部替换。编辑任何文件前必须先用 Read 读取它。',
  inputSchema: schema,
  isReadOnly: false,
  needsPermission: input => `编辑 ${input.file_path}`,
  async call(input, ctx) {
    const p = path.resolve(ctx.cwd(), input.file_path)
    const stateErr = checkFileState(p, ctx)
    if (stateErr) return stateErr
    if (input.old_string === input.new_string) return '错误：new_string 与 old_string 相同，无需编辑。'
    const content = fs.readFileSync(p, 'utf8')
    const count = content.split(input.old_string).length - 1
    if (count === 0) {
      return '错误：old_string 在文件中没有找到。常见原因：缩进或空白与原文不一致。请用 Read 重新确认原文后重试。'
    }
    if (count > 1 && !input.replace_all) {
      return `错误：old_string 在文件中出现了 ${count} 次，无法唯一定位。请提供更长的、包含上下文的唯一片段，或使用 replace_all。`
    }
    // 不用 String.replace：new_string 含 $& $$ 等会被特殊解释
    let updated: string
    if (input.replace_all) {
      updated = content.split(input.old_string).join(input.new_string)
    } else {
      const idx = content.indexOf(input.old_string)
      updated = content.slice(0, idx) + input.new_string + content.slice(idx + input.old_string.length)
    }
    ctx.recordBeforeImage?.(p)
    fs.writeFileSync(p, updated)
    ctx.fileState.set(p, fs.statSync(p).mtimeMs)
    return `已编辑 ${p}（替换 ${input.replace_all ? count : 1} 处）。`
  },
}
