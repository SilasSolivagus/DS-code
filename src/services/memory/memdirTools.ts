import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import type { Tool } from '../../tools/types.js'
import { readTool } from '../../tools/read.js'

/** 返回 null 表示允许；否则返回拒绝原因。target 解析后必须在 memdir 子树内。 */
export function assertInMemdir(memdir: string, target: string): string | null {
  const root = path.resolve(memdir)
  const abs = path.resolve(target)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return `拒绝：记忆工具只能写入 memory 目录（${root}）内，越界路径 ${abs} 被拦截。`
  }
  return null
}

const wschema = z.object({
  file_path: z.string().describe('memory 目录内的相对或绝对路径'),
  content: z.string().describe('完整文件内容（覆盖写）'),
})
const eschema = z.object({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
})

export function makeMemdirTools(memdir: string): Tool<any>[] {
  const resolve = (fp: string) => path.isAbsolute(fp) ? fp : path.join(memdir, fp)

  const memWrite: Tool<typeof wschema> = {
    name: 'MemWrite',
    description: '把整文件写入 memory 目录（自动建父目录）。仅限 memory 目录内。',
    inputSchema: wschema,
    isReadOnly: false,
    needsPermission: () => false, // forked 子代理无 UI；隔离靠路径断言
    deniablePaths: (input) => [path.isAbsolute(input.file_path) ? input.file_path : path.join(memdir, input.file_path)],
    async call(input) {
      const p = resolve(input.file_path)
      const deny = assertInMemdir(memdir, p)
      if (deny) return deny
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, input.content)
      } catch (e: any) { return `错误：写入失败 ${p}：${e?.message ?? e}` }
      return `已写入 ${p}（${input.content.length} 字符）。`
    },
  }

  const memEdit: Tool<typeof eschema> = {
    name: 'MemEdit',
    description: '在 memory 目录内的文件做精确字符串替换。仅限 memory 目录内。',
    inputSchema: eschema,
    isReadOnly: false,
    needsPermission: () => false,
    deniablePaths: (input) => [path.isAbsolute(input.file_path) ? input.file_path : path.join(memdir, input.file_path)],
    async call(input) {
      const p = resolve(input.file_path)
      const deny = assertInMemdir(memdir, p)
      if (deny) return deny
      let cur: string
      try { cur = fs.readFileSync(p, 'utf8') } catch { return `错误：文件不存在 ${p}` }
      if (!cur.includes(input.old_string)) return `错误：old_string 未匹配到。`
      try { fs.writeFileSync(p, cur.replace(input.old_string, input.new_string)) }
      catch (e: any) { return `错误：写入失败 ${p}：${e?.message ?? e}` }
      return `已编辑 ${p}。`
    },
  }

  return [readTool, memWrite, memEdit]
}
