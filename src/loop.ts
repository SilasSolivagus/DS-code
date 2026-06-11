// src/loop.ts
import type OpenAI from 'openai'
import { chatStream, type ChatResult, type ToolCall } from './api.js'
import type { Tool, ToolContext } from './tools/types.js'
import { toApiTools } from './tools/index.js'
import { checkPermission, type PermissionContext } from './permissions.js'

export type LoopEvent =
  | { type: 'text'; delta: string; reasoning?: boolean }
  | { type: 'tool_start'; id: string; name: string; desc: string }
  | { type: 'tool_end'; id: string; ok: boolean; preview: string }
  | { type: 'turn_end'; usage: ChatResult['usage'] }

export interface LoopDeps {
  client: OpenAI
  tools: Tool<any>[]
  model: string
  thinking: boolean
  permission: PermissionContext
  ctx: ToolContext
  maxTurns?: number
}

const CONCURRENCY = 5

/** 退出 loop 前调用：若 messages 以 tool 结尾，补一条收尾 assistant，保证下一轮 user 消息序列合法 */
function sealMessages(messages: any[], note: string): void {
  if (messages[messages.length - 1]?.role === 'tool') {
    messages.push({ role: 'assistant', content: note })
  }
}

function previewOf(content: string): string {
  const first = content.split('\n')[0]
  return first.length > 80 ? first.slice(0, 80) + '…' : first
}

async function execCall(call: ToolCall, deps: LoopDeps): Promise<{ ok: boolean; content: string }> {
  const tool = deps.tools.find(t => t.name === call.name)
  if (!tool) {
    return {
      ok: false,
      content: `错误：工具 ${call.name} 不存在。可用工具：${deps.tools.map(t => t.name).join(', ')}`,
    }
  }
  let raw: unknown
  try {
    raw = JSON.parse(call.args || '{}')
  } catch {
    return { ok: false, content: '错误：参数不是合法 JSON。请重新发起本次工具调用，确保 arguments 是完整 JSON 对象。' }
  }
  const parsed = tool.inputSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; ')
    return { ok: false, content: `错误：参数不符合 schema：${issues}` }
  }
  const perm = await checkPermission(tool, parsed.data, deps.permission)
  if (!perm.ok) return { ok: false, content: perm.reason }
  try {
    return { ok: true, content: await tool.call(parsed.data, deps.ctx) }
  } catch (e: any) {
    return { ok: false, content: `错误：${e?.message ?? String(e)}` }
  }
}

export async function* runLoop(
  messages: any[],
  deps: LoopDeps,
): AsyncGenerator<LoopEvent, 'done' | 'aborted' | 'max_turns'> {
  const apiTools = toApiTools(deps.tools)
  for (let turn = 0; turn < (deps.maxTurns ?? 80); turn++) {
    let result: ChatResult
    try {
      const stream = chatStream(deps.client, {
        model: deps.model,
        messages,
        tools: apiTools,
        thinking: deps.thinking,
        signal: deps.ctx.signal,
      })
      while (true) {
        const step = await stream.next()
        if (step.done) {
          result = step.value
          break
        }
        yield {
          type: 'text',
          delta: step.value.delta,
          ...(step.value.type === 'reasoning' ? { reasoning: true } : {}),
        }
      }
    } catch (e) {
      if (deps.ctx.signal.aborted) {
        sealMessages(messages, '（本轮已被用户中断。）')
        return 'aborted'
      }
      throw e
    }

    messages.push({
      role: 'assistant',
      content: result.content || null,
      ...(result.toolCalls.length
        ? {
            tool_calls: result.toolCalls.map(c => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: c.args },
            })),
          }
        : {}),
    })
    if (!result.toolCalls.length) {
      yield { type: 'turn_end', usage: result.usage }
      // 被长度上限截断且无工具调用：自动追加续写请求，进入下一轮（仍受 maxTurns 约束）
      if (result.finishReason === 'length') {
        messages.push({ role: 'user', content: '（上一条回复因长度上限被截断，请继续输出剩余内容。）' })
        continue
      }
      return 'done'
    }

    // 只读并发（上限 5），非只读串行；未知工具默认归入只读批（execCall 会返回错误结果）
    const outcomes = new Map<string, { ok: boolean; content: string }>()
    const isRO = (c: ToolCall) => deps.tools.find(t => t.name === c.name)?.isReadOnly ?? true
    const ro = result.toolCalls.filter(isRO)
    const rw = result.toolCalls.filter(c => !isRO(c))

    for (const c of ro) yield { type: 'tool_start', id: c.id, name: c.name, desc: c.args }
    for (let i = 0; i < ro.length; i += CONCURRENCY) {
      const batch = ro.slice(i, i + CONCURRENCY)
      const results = await Promise.all(batch.map(c => execCall(c, deps)))
      batch.forEach((c, j) => outcomes.set(c.id, results[j]))
    }
    for (const c of ro) {
      const o = outcomes.get(c.id)!
      yield { type: 'tool_end', id: c.id, ok: o.ok, preview: previewOf(o.content) }
    }

    for (const c of rw) {
      yield { type: 'tool_start', id: c.id, name: c.name, desc: c.args }
      if (deps.ctx.signal.aborted) outcomes.set(c.id, { ok: false, content: '已被用户中断，未执行' })
      else outcomes.set(c.id, await execCall(c, deps))
      const o = outcomes.get(c.id)!
      yield { type: 'tool_end', id: c.id, ok: o.ok, preview: previewOf(o.content) }
    }

    // 工具结果必须按原始 tool_calls 顺序回灌
    for (const c of result.toolCalls) {
      messages.push({ role: 'tool', tool_call_id: c.id, content: outcomes.get(c.id)!.content })
    }
    yield { type: 'turn_end', usage: result.usage }
    if (deps.ctx.signal.aborted) {
      sealMessages(messages, '（本轮已被用户中断。）')
      return 'aborted'
    }
  }
  sealMessages(messages, '（已达最大轮数上限，已停止。）')
  return 'max_turns'
}
