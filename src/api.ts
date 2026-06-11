import OpenAI from 'openai'

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

  /** 喂入一个流式分片，返回其中的文本增量（无则空串） */
  push(chunk: any): string {
    if (chunk?.usage) {
      this.usage = {
        prompt_tokens: chunk.usage.prompt_tokens ?? 0,
        completion_tokens: chunk.usage.completion_tokens ?? 0,
        prompt_cache_hit_tokens: chunk.usage.prompt_cache_hit_tokens ?? 0,
      }
    }
    const choice = chunk?.choices?.[0]
    if (!choice) return ''
    if (choice.finish_reason) this.finishReason = choice.finish_reason
    const delta = choice.delta ?? {}
    for (const tc of delta.tool_calls ?? []) {
      const slot = this.calls.get(tc.index) ?? { id: '', name: '', args: '' }
      if (tc.id) slot.id = tc.id
      if (tc.function?.name) slot.name += tc.function.name
      if (tc.function?.arguments) slot.args += tc.function.arguments
      this.calls.set(tc.index, slot)
    }
    const text: string = delta.content ?? ''
    this.content += text
    return text
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

export function createClient(): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('缺少 DEEPSEEK_API_KEY 环境变量。请先 export DEEPSEEK_API_KEY=sk-...')
  return new OpenAI({ apiKey, baseURL: 'https://api.deepseek.com' })
}

export interface ChatOptions {
  model: string
  messages: any[]
  tools: any[]
  thinking: boolean
  signal: AbortSignal
}

export async function* chatStream(client: OpenAI, opts: ChatOptions): AsyncGenerator<string, ChatResult> {
  // 重试只覆盖"建立流"；分片开始到达后中断则直接抛出
  const stream = await withRetry(() =>
    client.chat.completions.create(
      {
        model: opts.model,
        messages: opts.messages,
        ...(opts.tools.length ? { tools: opts.tools } : {}),
        stream: true,
        stream_options: { include_usage: true },
        ...(opts.thinking ? { reasoning_effort: 'medium', thinking: { type: 'enabled' } } : {}),
      } as any,
      { signal: opts.signal },
    ),
  )
  const asm = new Assembler()
  for await (const chunk of stream as any) {
    const text = asm.push(chunk)
    if (text) yield text
  }
  return asm.finish()
}
