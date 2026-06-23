// src/tools/grep.ts
import { z } from 'zod'
import { execFile } from 'node:child_process'
import fg from 'fast-glob'
import fs from 'node:fs'
import path from 'node:path'
import type { Tool } from './types.js'
import { isDeniedPath } from '../deny.js'

const MAX_RESULTS = 100

const schema = z.object({
  pattern: z.string().describe('要搜索的正则表达式'),
  path: z.string().optional().describe('搜索目录，默认当前工作目录'),
  glob: z.string().optional().describe('文件名过滤，如 *.ts'),
})

/** 系统 rg 搜索；返回 null 表示 rg 未安装需降级 */
function rgSearch(pattern: string, dir: string, glob?: string): Promise<string | null> {
  return new Promise(resolve => {
    const args = ['-n', '--no-heading', '-S', '--max-count', '20', pattern, ...(glob ? ['-g', glob] : []), '.']
    execFile('rg', args, { cwd: dir, maxBuffer: 10 * 1024 * 1024 }, (err: any, stdout) => {
      if (err && err.code === 'ENOENT') return resolve(null) // 没装 rg
      if (err && err.code === 1) return resolve('') // rg 退出码 1 = 无匹配
      if (err) return resolve(err.code === 2 ? null : '') // 2 = rg 自身错误（如非法正则）→ 降级 jsSearch 给出真实报错
      resolve(stdout)
    })
  })
}

async function jsSearch(pattern: string, dir: string, glob?: string): Promise<string> {
  const re = new RegExp(pattern)
  const files = await fg(glob ?? '**/*', {
    cwd: dir,
    onlyFiles: true,
    ignore: ['**/node_modules/**', '**/.git/**'],
  })
  const out: string[] = []
  for (const f of files) {
    let text: string
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length && out.length < MAX_RESULTS; i++) {
      if (re.test(lines[i])) out.push(`${f}:${i + 1}:${lines[i].slice(0, 200)}`)
    }
    if (out.length >= MAX_RESULTS) break
  }
  return out.join('\n')
}

export const grepTool: Tool<typeof schema> = {
  name: 'Grep',
  description: '在文件内容中按正则搜索，返回 文件:行号:行内容（最多 100 条）。找文件名用 Glob，找内容用本工具。',
  inputSchema: schema,
  isReadOnly: true,
  needsPermission: () => false,
  workspacePaths: (input, cwd) => [input.path ? path.resolve(cwd, input.path) : path.resolve(cwd)],
  async call(input, ctx) {
    const dir = input.path ? path.resolve(ctx.cwd(), input.path) : ctx.cwd()
    let result = await rgSearch(input.pattern, dir, input.glob)
    if (result === null) {
      try {
        result = await jsSearch(input.pattern, dir, input.glob)
      } catch (e) {
        return `Grep 错误：${(e as Error).message}`
      }
    }
    if (!result.trim()) return '没有匹配'
    const deny = ctx.denyPatterns?.() ?? []
    let allLines = result.trim().split('\n')
    let denied = 0
    if (deny.length) {
      allLines = allLines.filter(l => {
        const m = l.match(/^(.+?):\d+:/)
        if (m && isDeniedPath(path.resolve(dir, m[1]), deny)) { denied++; return false }
        return true
      })
    }
    if (!allLines.length) return '没有匹配'
    const shown = allLines.slice(0, MAX_RESULTS)
    const note = allLines.length > MAX_RESULTS ? `\n[已截断，只显示前 ${MAX_RESULTS} 条]` : ''
    const denyNote = denied ? `\n[${denied} 行被 deny 规则过滤]` : ''
    return shown.join('\n') + note + denyNote
  },
}
