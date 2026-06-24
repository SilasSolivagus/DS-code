// src/tools/glob.ts
import { z } from 'zod'
import fg from 'fast-glob'
import path from 'node:path'
import type { Tool } from './types.js'
import { isDeniedPath } from '../deny.js'

const schema = z.object({
  pattern: z.string().describe('glob 模式，如 src/**/*.ts'),
  path: z.string().optional().describe('搜索根目录，默认当前工作目录'),
})

export const globTool: Tool<typeof schema> = {
  name: 'Glob',
  description: '按 glob 模式查找文件，返回相对路径列表（最多 100 条，自动忽略 node_modules/.git）。支持 glob 模式（如 **/*.ts、src/**/test_*）；结果按修改时间排序返回。',
  inputSchema: schema,
  isReadOnly: true,
  needsPermission: () => false,
  workspacePaths: (input, cwd) => [input.path ? path.resolve(cwd, input.path) : path.resolve(cwd)],
  async call(input, ctx) {
    const cwd = input.path ? path.resolve(ctx.cwd(), input.path) : ctx.cwd()
    const files = await fg(input.pattern, {
      cwd,
      onlyFiles: true,
      dot: false,
      ignore: ['**/node_modules/**', '**/.git/**'],
    })
    const deny = ctx.denyPatterns?.() ?? []
    let denied = 0
    let kept = files
    if (deny.length) {
      kept = files.filter(f => {
        if (isDeniedPath(path.resolve(cwd, f), deny)) { denied++; return false }
        return true
      })
    }
    if (!kept.length) return '没有匹配的文件'
    const shown = kept.slice(0, 100)
    const note = kept.length > 100 ? `\n[共 ${kept.length} 个，已截断只显示前 100 个]` : ''
    const denyNote = denied ? `\n[${denied} 个结果被 deny 规则过滤]` : ''
    return shown.join('\n') + note + denyNote
  },
}
