import type OpenAI from 'openai'
import { scanMemoryFiles as realScan, formatMemoryManifest, type MemoryHeader } from './memoryScan.js'

export interface FindOpts {
  maxResults: number
  model: string
  signal: AbortSignal
  scan?: (memdir: string) => Promise<MemoryHeader[]>
}

const SYS = '你从记忆清单里挑出与用户当前请求最相关的文件。只输出 JSON：{"selected":["file1.md",...]}，最多挑给定上限，无相关就空数组。'

export async function findRelevantMemories(client: OpenAI, query: string, memdir: string, opts: FindOpts): Promise<string[]> {
  try {
    const heads = await (opts.scan ?? realScan)(memdir)
    if (!heads.length) return []
    const valid = new Set(heads.map(h => h.filename))
    const res = await client.chat.completions.create({
      model: opts.model, max_tokens: 256,
      messages: [
        { role: 'system', content: SYS },
        { role: 'user', content: `用户请求：${query}\n\n记忆清单：\n${formatMemoryManifest(heads)}\n\n最多挑 ${opts.maxResults} 个。` },
      ],
    } as any, { signal: opts.signal })
    const content = (res as any).choices?.[0]?.message?.content ?? ''
    const m = content.match(/\{[\s\S]*\}/)
    if (!m) return []
    const parsed = JSON.parse(m[0])
    const sel: unknown = parsed?.selected
    if (!Array.isArray(sel)) return []
    return sel.filter((s): s is string => typeof s === 'string' && valid.has(s)).slice(0, opts.maxResults)
  } catch { return [] }
}
