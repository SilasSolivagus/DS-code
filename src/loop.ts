// src/loop.ts
import type OpenAI from 'openai'
import { chatStream, type ChatResult, type ToolCall } from './api.js'
import type { Tool, ToolContext } from './tools/types.js'
import { toApiTools } from './tools/index.js'
import { checkPermission, type PermissionContext } from './permissions.js'

export type LoopEvent =
  | { type: 'text'; delta: string; reasoning?: boolean }
  | { type: 'tool_start'; id: string; name: string; desc: string }
  | { type: 'tool_end'; id: string; ok: boolean; preview: string; ms: number }
  | { type: 'turn_end'; usage: ChatResult['usage'] }

export interface LoopDeps {
  client: OpenAI
  tools: Tool<any>[]
  model: string
  thinking: boolean
  permission: PermissionContext
  ctx: ToolContext
  maxTurns?: number
  /** 每个含工具调用的 loop turn 在结果回灌前调用一次；返回的条目合并为一个 <system-reminder> 块
   *  附加到本轮最后一条 tool 消息末尾（只动最新后缀，不破坏 KV 缓存）。
   *  调用方可借此推进轮计数（如 TodoStore.tick）。
   *  供给函数不得抛异常（抛出会丢失该轮 usage 记录）。 */
  reminders?: () => string[]
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

/** ms 只计 tool.call 的实际执行时间，不含权限等待等前置环节；前置环节出错时 ms 为 0 */
async function execCall(call: ToolCall, deps: LoopDeps): Promise<{ ok: boolean; content: string; ms: number }> {
  const tool = deps.tools.find(t => t.name === call.name)
  if (!tool) {
    return {
      ok: false,
      content: `错误：工具 ${call.name} 不存在。可用工具：${deps.tools.map(t => t.name).join(', ')}`,
      ms: 0,
    }
  }
  let raw: unknown
  try {
    raw = JSON.parse(call.args || '{}')
  } catch {
    return { ok: false, content: '错误：参数不是合法 JSON。请重新发起本次工具调用，确保 arguments 是完整 JSON 对象。', ms: 0 }
  }
  const parsed = tool.inputSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; ')
    return { ok: false, content: `错误：参数不符合 schema：${issues}`, ms: 0 }
  }
  const perm = await checkPermission(tool, parsed.data, deps.permission)
  if (!perm.ok) return { ok: false, content: perm.reason, ms: 0 }
  const t0 = Date.now()
  try {
    return { ok: true, content: await tool.call(parsed.data, deps.ctx), ms: Date.now() - t0 }
  } catch (e: any) {
    return { ok: false, content: `错误：${e?.message ?? String(e)}`, ms: Date.now() - t0 }
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
    const outcomes = new Map<string, { ok: boolean; content: string; ms: number }>()
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
      yield { type: 'tool_end', id: c.id, ok: o.ok, preview: previewOf(o.content), ms: o.ms }
    }

    for (const c of rw) {
      yield { type: 'tool_start', id: c.id, name: c.name, desc: c.args }
      if (deps.ctx.signal.aborted) outcomes.set(c.id, { ok: false, content: '已被用户中断，未执行', ms: 0 })
      else outcomes.set(c.id, await execCall(c, deps))
      const o = outcomes.get(c.id)!
      yield { type: 'tool_end', id: c.id, ok: o.ok, preview: previewOf(o.content), ms: o.ms }
    }

    // 工具结果必须按原始 tool_calls 顺序回灌
    for (const c of result.toolCalls) {
      messages.push({ role: 'tool', tool_call_id: c.id, content: outcomes.get(c.id)!.content })
    }
    // system-reminder：附加到本轮最后一条 tool 消息（即将发送的最新后缀）
    const notes = deps.reminders?.() ?? []
    if (notes.length) {
      const last = messages[messages.length - 1] // 上面刚推完 tool 消息，必为 tool
      last.content += `\n\n<system-reminder>\n${notes.join('\n\n')}\n</system-reminder>`
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
