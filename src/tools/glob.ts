// src/tools/glob.ts
import { z } from 'zod'
import fg from 'fast-glob'
import path from 'node:path'
import type { Tool } from './types.js'

const schema = z.object({
  pattern: z.string().describe('glob 模式，如 src/**/*.ts'),
  path: z.string().optional().describe('搜索根目录，默认当前工作目录'),
})

export const globTool: Tool<typeof schema> = {
  name: 'Glob',
  description: '按 glob 模式查找文件，返回相对路径列表（最多 100 条，自动忽略 node_modules/.git）。',
  inputSchema: schema,
  isReadOnly: true,
  needsPermission: () => false,
  async call(input, ctx) {
    const cwd = input.path ? path.resolve(ctx.cwd(), input.path) : ctx.cwd()
    const files = await fg(input.pattern, {
      cwd,
      onlyFiles: true,
      dot: false,
      ignore: ['**/node_modules/**', '**/.git/**'],
    })
    if (!files.length) return '没有匹配的文件'
    const shown = files.slice(0, 100)
    const note = files.length > 100 ? `\n[共 ${files.length} 个，已截断只显示前 100 个]` : ''
    return shown.join('\n') + note
  },
}
