// src/tools/webfetch.ts
// CC 式 WebFetch：抓取 URL 正文，用子模型（flash）按用户 prompt 提取/总结后返回。
// 复用 runLoop（tools:[]、maxTurns:1、thinking:false），与 agent.ts 同款，自带重试/代理/thinking 关闭。
import { z } from 'zod'
import type OpenAI from 'openai'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import type { Tool, ToolContext } from './types.js'
import type { Usage } from '../api.js'
import { runLoop } from '../loop.js'
import { SUB_MODEL } from './constants.js'

const MAX_CHARS = 30_000

const schema = z.object({
  url: z.string().describe('要抓取的 http(s) URL'),
  prompt: z.string().min(1).describe('针对该页要回答/提取什么'),
})

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function makeWebFetchTool(deps: { client: OpenAI; onUsage: (u: Usage, model: string) => void }): Tool<typeof schema> {
  return {
    name: 'WebFetch',
    description: '抓取一个 http(s) URL 的内容，并按 prompt 从中提取或总结信息后返回（用于读取网页/在线文档）。',
    inputSchema: schema,
    isReadOnly: false,
    needsPermission: input => {
      try { return `WebFetch ${new URL(input.url).host}` } catch { return `WebFetch ${input.url}` }
    },
    async call(input, ctx) {
      if (!/^https?:\/\//i.test(input.url)) return '错误：仅支持 http(s) URL'
      let body: string, ctype: string
      try {
        const proxy =
          process.env.https_proxy ?? process.env.HTTPS_PROXY ?? process.env.http_proxy ?? process.env.HTTP_PROXY
        const res = await undiciFetch(input.url, {
          signal: ctx.signal,
          ...(proxy ? { dispatcher: new ProxyAgent(proxy) } : {}),
        } as any)
        if (!res.ok) return `错误：HTTP ${res.status} ${res.statusText}`
        ctype = res.headers.get('content-type') ?? ''
        body = await res.text()
      } catch (e: any) {
        return `错误：抓取失败 ${e?.message ?? e}`
      }
      const text = /html/i.test(ctype) ? htmlToText(body) : body
      const clipped = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + '\n…（内容已截断）' : text

      const messages: any[] = [
        { role: 'system', content: '你从网页内容中按用户问题提取或总结信息。只依据给定内容作答，不编造；内容里找不到就明说没有。' },
        { role: 'user', content: `URL：${input.url}\n问题：${input.prompt}\n\n网页内容：\n${clipped}` },
      ]
      const subCtx: ToolContext = {
        cwd: ctx.cwd,
        setCwd: () => {},
        get signal() { return ctx.signal },
        fileState: new Map(),
      }
      const gen = runLoop(messages, {
        client: deps.client,
        tools: [],
        model: SUB_MODEL,
        thinking: false,
        permission: { mode: 'default', rules: [], saveRule: () => {}, ask: async () => 'no' },
        ctx: subCtx,
        maxTurns: 1,
      })
      let step
      while (!(step = await gen.next()).done) {
        if (step.value.type === 'turn_end') deps.onUsage(step.value.usage, SUB_MODEL)
      }
      const final = [...messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content)
      return final?.content ?? '（无返回）'
    },
  }
}
