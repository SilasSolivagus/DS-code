// src/tools/webSearchTool.ts —— WebSearch 工具：双源并查 + 合并 + CC 式输出。
import { z } from 'zod'
import type { Tool, ToolContext } from './types.js'
import type { Settings } from '../config.js'
import {
  bochaSearch, tavilySearch, mergeResults,
  type WebSearchResult, type WebSearchOpts, type FetchJson,
} from '../webSearch.js'

const schema = z.object({
  query: z.string().min(2).describe('The search query to use'),
  allowed_domains: z.array(z.string()).optional().describe('Only include search results from these domains'),
  blocked_domains: z.array(z.string()).optional().describe('Never include search results from these domains'),
})

export interface WebSearchConfig { bocha?: string; tavily?: string }

/** env(BOCHA_API_KEY/TAVILY_API_KEY) 优先于 settings.webSearch。 */
export function resolveWebSearchConfig(settings: Settings): WebSearchConfig {
  const ws = settings.webSearch
  const bocha = process.env.BOCHA_API_KEY ?? ws?.bocha?.apiKey
  const tavily = process.env.TAVILY_API_KEY ?? ws?.tavily?.apiKey
  return { ...(bocha ? { bocha } : {}), ...(tavily ? { tavily } : {}) }
}

function hostMatches(url: string, domains: string[]): boolean {
  let host: string
  try { host = new URL(url).host.toLowerCase() } catch { return false }
  return domains.some(d => { const dd = d.toLowerCase(); return host === dd || host.endsWith('.' + dd) })
}
function filterByDomain(list: WebSearchResult[], allowed?: string[], blocked?: string[]): WebSearchResult[] {
  if (allowed?.length) return list.filter(r => hostMatches(r.url, allowed))
  if (blocked?.length) return list.filter(r => !hostMatches(r.url, blocked))
  return list
}

function formatResults(query: string, results: WebSearchResult[]): string {
  const body = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n')
  return `Web search results for query: "${query}"\n\n${body}\n\n` +
    `REMINDER: 回答中必须用 markdown 超链接把上面用到的来源列在末尾的 "Sources:" 段（- [标题](URL)）。`
}

export function makeWebSearchTool(deps: { config: WebSearchConfig; fetchJson?: FetchJson }): Tool<typeof schema> {
  const year = new Date().toISOString().slice(0, 7)
  return {
    name: 'WebSearch',
    description:
      `搜索网络获取最新信息（当前事件、知识截止后的资料、最新文档），返回标题/链接/摘要。` +
      `回答后必须在末尾加 "Sources:" 段，用 markdown 超链接 [标题](URL) 列出用到的来源（强制）。` +
      `支持 allowed_domains/blocked_domains 域名过滤（二选一）。搜索查询请用正确年份（当前 ${year}）。`,
    inputSchema: schema,
    isReadOnly: false,
    needsPermission: () => 'WebSearch',
    async call(input, ctx: ToolContext) {
      if (input.allowed_domains?.length && input.blocked_domains?.length) {
        return '错误：不能同时指定 allowed_domains 和 blocked_domains'
      }
      const { bocha, tavily } = deps.config
      if (!bocha && !tavily) {
        return '错误：未配置任何搜索源（在 settings.json 的 webSearch 填 bocha/tavily 的 apiKey）'
      }
      const opts: WebSearchOpts = {
        allowedDomains: input.allowed_domains, blockedDomains: input.blocked_domains, count: 5, signal: ctx.signal,
      }
      const jobs: Array<{ name: 'bocha' | 'tavily'; p: Promise<WebSearchResult[]> }> = []
      if (bocha) jobs.push({ name: 'bocha', p: bochaSearch(bocha, input.query, opts, deps.fetchJson) })
      if (tavily) jobs.push({ name: 'tavily', p: tavilySearch(tavily, input.query, opts, deps.fetchJson) })
      const settled = await Promise.allSettled(jobs.map(j => j.p))
      const lists: WebSearchResult[][] = []
      const errors: string[] = []
      settled.forEach((s, i) => {
        if (s.status === 'fulfilled') {
          // Bocha 无原生域名过滤 → 客户端过滤；Tavily 已原生过滤
          lists.push(jobs[i].name === 'bocha' ? filterByDomain(s.value, input.allowed_domains, input.blocked_domains) : s.value)
        } else {
          errors.push(`${jobs[i].name}: ${s.reason?.message ?? s.reason}`)
        }
      })
      if (!lists.length) return `错误：搜索失败（${errors.join('；')}）`
      const merged = mergeResults(lists)
      if (!merged.length) return `未找到结果：${input.query}`
      return formatResults(input.query, merged)
    },
  }
}
