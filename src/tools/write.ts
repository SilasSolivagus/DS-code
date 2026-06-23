// src/tools/write.ts
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import type { Tool } from './types.js'
import { checkFileState } from './edit.js'

const schema = z.object({
  file_path: z.string().describe('要写入的文件路径'),
  content: z.string().describe('完整的文件内容（整文件覆盖写入）'),
})

export const writeTool: Tool<typeof schema> = {
  name: 'Write',
  description:
    '整文件写入，自动创建父目录。文件已存在时是覆盖操作，必须先用 Read 读取过该文件；新建文件无此要求。对已有文件做局部修改请优先用 Edit。',
  inputSchema: schema,
  isReadOnly: false,
  needsPermission: input => `写入 ${input.file_path}`,
  deniablePaths: (input, cwd) => [path.resolve(cwd, input.file_path)],
  workspacePaths: (input, cwd) => [path.resolve(cwd, input.file_path)],
  async call(input, ctx) {
    const p = path.resolve(ctx.cwd(), input.file_path)
    if (fs.existsSync(p)) {
      const stateErr = checkFileState(p, ctx)
      if (stateErr) return stateErr
    }
    ctx.recordBeforeImage?.(p)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, input.content)
    ctx.fileState.set(p, fs.statSync(p).mtimeMs)
    return `已写入 ${p}（${input.content.length} 字符）。`
  },
}
