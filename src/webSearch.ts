// src/webSearch.ts —— WebSearch 双源（Bocha+Tavily）provider + 合并去重。
import { fetch as undiciFetch, ProxyAgent } from 'undici'

export interface WebSearchResult { title: string; url: string; snippet: string }
export interface WebSearchOpts { allowedDomains?: string[]; blockedDomains?: string[]; count?: number; signal?: AbortSignal }
export type FetchJson = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<any>

/** undici + ProxyAgent（本机必走代理），镜像 webfetch.ts。非 2xx 抛错。 */
export const defaultFetchJson: FetchJson = async (url, init) => {
  const proxy = process.env.https_proxy ?? process.env.HTTPS_PROXY ?? process.env.http_proxy ?? process.env.HTTP_PROXY
  const res = await undiciFetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    ...(proxy ? { dispatcher: new ProxyAgent(proxy) } : {}),
  } as any)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  return res.json()
}

export async function bochaSearch(
  apiKey: string,
  query: string,
  opts: WebSearchOpts,
  fetchJson: FetchJson = defaultFetchJson,
): Promise<WebSearchResult[]> {
  const json = await fetchJson('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, count: opts.count ?? 5, freshness: 'noLimit' }),
    signal: opts.signal,
  })
  const value: any[] = json?.data?.webPages?.value ?? []
  return value
    .map(v => ({ title: String(v?.name ?? ''), url: String(v?.url ?? ''), snippet: String(v?.snippet ?? '') }))
    .filter(r => r.url)
}

export async function tavilySearch(
  apiKey: string,
  query: string,
  opts: WebSearchOpts,
  fetchJson: FetchJson = defaultFetchJson,
): Promise<WebSearchResult[]> {
  const body: Record<string, unknown> = { query, max_results: opts.count ?? 5 }
  if (opts.allowedDomains?.length) body.include_domains = opts.allowedDomains
  if (opts.blockedDomains?.length) body.exclude_domains = opts.blockedDomains
  const json = await fetchJson('https://api.tavily.com/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  const results: any[] = json?.results ?? []
  return results
    .map(r => ({ title: String(r?.title ?? ''), url: String(r?.url ?? ''), snippet: String(r?.content ?? '') }))
    .filter(r => r.url)
}
