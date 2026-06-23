import OpenAI from 'openai'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { loadSettings } from './config.js'
import { resolveActiveProvider } from './providers.js'

export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  prompt_cache_hit_tokens: number
}

export interface ToolCall { id: string; name: string; args: string }

export interface ChatResult {
  content: string
  toolCalls: ToolCall[]
  usage: Usage
  finishReason: string
}

// 流式分片拼装器。DeepSeek（OpenAI 兼容）的 tool_calls 按 index 分片到达：
// id/name 在首个分片，arguments 是后续分片的字符串增量，必须按 index 聚合。
export class Assembler {
  private content = ''
  private finishReason = ''
  private usage: Usage = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 }
  private calls = new Map<number, { id: string; name: string; args: string }>()

  /** 喂入一个流式分片，返回其中的文本增量 */
  push(chunk: any): { text: string; reasoning: string } {
    if (chunk?.usage) {
      this.usage = {
        prompt_tokens: chunk.usage.prompt_tokens ?? 0,
        completion_tokens: chunk.usage.completion_tokens ?? 0,
        prompt_cache_hit_tokens: chunk.usage.prompt_cache_hit_tokens ?? 0,
      }
    }
    const choice = chunk?.choices?.[0]
    if (!choice) return { text: '', reasoning: '' }
    if (choice.finish_reason) this.finishReason = choice.finish_reason
    const delta = choice.delta ?? {}
    for (const tc of delta.tool_calls ?? []) {
      const slot = this.calls.get(tc.index) ?? { id: '', name: '', args: '' }
      if (tc.id) slot.id = tc.id
      if (tc.function?.name) slot.name = tc.function.name
      if (tc.function?.arguments) slot.args += tc.function.arguments
      this.calls.set(tc.index, slot)
    }
    // reasoning_content（thinking 模式的思考流）只用于显示，不进 content/messages
    const text: string = delta.content ?? ''
    this.content += text
    return { text, reasoning: delta.reasoning_content ?? '' }
  }

  finish(): ChatResult {
    return {
      content: this.content,
      toolCalls: [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c),
      usage: this.usage,
      finishReason: this.finishReason,
    }
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE'])

const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      const retryable =
        RETRYABLE_STATUS.has(err?.status) ||
        RETRYABLE_CODES.has(err?.code) ||
        err?.name === 'APIConnectionError'
      if (attempt >= maxRetries || !retryable) throw err
      await sleep(1000 * 2 ** attempt)
    }
  }
}

export function createClient(flagSettingsPath?: string): OpenAI {
  const settings = loadSettings(process.cwd(), flagSettingsPath)
  const preset = resolveActiveProvider(settings)
  const providerKey = (settings.providers as any)?.[preset.id]?.apiKey
  const apiKey = process.env[preset.apiKeyEnv] ?? providerKey ?? settings.apiKey
  if (!apiKey) {
    throw new Error(`缺少 ${preset.id} API key。设置环境变量 ${preset.apiKeyEnv}=...，或在 ~/.deepcode/settings.json 的 providers.${preset.id}.apiKey 配置`)
  }
  // Node fetch 不读代理环境变量；显式接入，否则需走代理的网络环境下请求会超时
  const proxy =
    process.env.https_proxy ?? process.env.HTTPS_PROXY ?? process.env.http_proxy ?? process.env.HTTP_PROXY
  const baseURL = settings.baseURL ?? preset.baseURL
  return new OpenAI({
    apiKey,
    baseURL,
    maxRetries: 0, // 重试统一由 withRetry 负责，避免与 SDK 自带重试叠加
    // dispatcher 必须配同一 undici 包的 fetch，混用 Node 内置 fetch 会 InvalidArgumentError
    ...(proxy ? { fetch: undiciFetch as any, fetchOptions: { dispatcher: new ProxyAgent(proxy) } as any } : {}),
  })
}

export interface ChatOptions {
  model: string
  messages: any[]
  tools: any[]
  thinking: boolean
  effortLevel?: 'low' | 'medium' | 'high'
  signal: AbortSignal
}

export type StreamDelta = { type: 'text' | 'reasoning'; delta: string }

export async function* chatStream(client: OpenAI, opts: ChatOptions): AsyncGenerator<StreamDelta, ChatResult> {
  // 重试只覆盖"建立流"；分片开始到达后中断则直接抛出
  const stream = await withRetry(() =>
    client.chat.completions.create(
      {
        model: opts.model,
        messages: opts.messages,
        ...(opts.tools.length ? { tools: opts.tools } : {}),
        stream: true,
        stream_options: { include_usage: true },
        // v4 系列默认开 thinking（白烧思考 token），必须显式 disabled
        ...(opts.thinking
          ? { reasoning_effort: opts.effortLevel ?? 'medium', thinking: { type: 'enabled' } }
          : { thinking: { type: 'disabled' } }),
      } as any,
      { signal: opts.signal },
    ),
  )
  const asm = new Assembler()
  for await (const chunk of stream as any) {
    const { text, reasoning } = asm.push(chunk)
    if (reasoning) yield { type: 'reasoning', delta: reasoning }
    if (text) yield { type: 'text', delta: text }
  }
  return asm.finish()
}
