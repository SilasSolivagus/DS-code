import fs from 'node:fs/promises'
import path from 'node:path'
import { parseFrontmatter } from '../agentsLoader.js'
import { isMemoryType, type MemoryType } from './memoryTypes.js'

export const MAX_MEMORY_FILES = 200

export interface MemoryHeader {
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
}

export async function scanMemoryFiles(memdir: string): Promise<MemoryHeader[]> {
  let entries: string[]
  try {
    entries = (await fs.readdir(memdir, { recursive: true }) as string[])
      .filter(f => f.endsWith('.md') && path.basename(f) !== 'MEMORY.md')
  } catch { return [] }

  const heads = await Promise.all(entries.map(async (filename): Promise<MemoryHeader | null> => {
    const filePath = path.join(memdir, filename)
    try {
      const stat = await fs.stat(filePath)
      if (!stat.isFile()) return null
      const head = (await fs.readFile(filePath, 'utf8')).split('\n').slice(0, 30).join('\n')
      const { data } = parseFrontmatter(head + '\n')
      const desc = typeof data.description === 'string' ? data.description : null
      const type = isMemoryType(data.type) ? data.type : undefined
      return { filename, filePath, mtimeMs: stat.mtimeMs, description: desc, type }
    } catch { return null }
  }))

  return heads.filter((h): h is MemoryHeader => h !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_MEMORY_FILES)
}

export function formatMemoryManifest(headers: MemoryHeader[]): string {
  if (!headers.length) return '（暂无记忆文件）'
  return headers.map(h => `- [${h.type ?? '?'}] ${h.filename}: ${h.description ?? '(无描述)'}`).join('\n')
}
