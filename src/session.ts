// src/session.ts
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export interface SessionMeta {
  cwd: string
  model: string
  providerId?: string
  thinking: boolean
  effortLevel?: 'low' | 'medium' | 'high'
  permMode: string
}

export interface UsageRecord {
  usage: { prompt_tokens: number; completion_tokens: number; prompt_cache_hit_tokens: number }
  model: string
  kind?: 'memory'
}

export interface SessionHandle {
  file: string
  appendMessage(m: any, turn?: number): void
  appendUsage(usage: UsageRecord['usage'], model: string): void
  appendFileState(entries: [string, number][]): void
  appendMeta(meta: SessionMeta): void
  appendCompact(): void
  appendRewind(toTurnId: number): void
}

export interface LoadedSession {
  meta: SessionMeta
  messages: any[]
  usages: UsageRecord[]
  fileState: [string, number][]
  messageTurnIds: (number | undefined)[]
  maxTurnId: number
}

export interface SessionInfo {
  file: string
  mtimeMs: number
  preview: string
}

const DEFAULT_DIR = path.join(os.homedir(), '.deepcode', 'sessions')

function makeHandle(file: string): SessionHandle {
  let dead = false // 首次写失败后降级为仅内存，避免磁盘问题杀死 REPL
  const append = (obj: any) => {
    if (dead) return
    try { fs.appendFileSync(file, JSON.stringify(obj) + '\n') }
    catch (e: any) {
      dead = true
      console.error('[session] 落盘失败，本会话改为仅内存：' + (e?.message ?? e))
    }
  }
  return {
    file,
    appendMessage: (m, turn) => append(turn === undefined ? { t: 'msg', m } : { t: 'msg', m, turn }),
    appendUsage: (usage, model) => append({ t: 'usage', usage, model }),
    appendFileState: entries => append({ t: 'fs', entries }),
    appendMeta: meta => append({ t: 'meta', ...meta }),
    appendCompact: () => append({ t: 'compact' }),
    appendRewind: toTurnId => append({ t: 'rewind', toTurnId }),
  }
}

/** 会话文件路径 → 会话 ID（basename 去 .jsonl）。会话级 hook payload 的 session_id；①b-3 env-file 目录键。 */
export function sessionIdFromFile(file: string): string {
  return path.basename(file).replace(/\.jsonl$/, '')
}

/** 新会话：建目录、写 meta 首行、返回句柄。文件名含可读时间戳 + 随机段防碰撞。 */
export function newSession(meta: SessionMeta, dir: string = DEFAULT_DIR): SessionHandle {
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const rand = Math.floor(Math.random() * 1e6).toString(36)
  const file = path.join(dir, `${stamp}-${rand}.jsonl`)
  fs.writeFileSync(file, JSON.stringify({ t: 'meta', ...meta, createdAt: Date.now() }) + '\n')
  return makeHandle(file)
}

/** 续写已有会话文件（resume 用），不重写 meta。 */
export function openSession(file: string): SessionHandle {
  return makeHandle(file)
}

export function loadSession(file: string): LoadedSession {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  let meta: SessionMeta = { cwd: '', model: 'deepseek-v4-flash', thinking: false, permMode: 'default' }
  let sawMeta = false // cwd 是会话身份，只取首条 meta；其余字段后写覆盖
  let messages: any[] = []
  let messageTurnIds: (number | undefined)[] = []
  let maxTurnId = 0
  const usages: UsageRecord[] = []
  let fileState: [string, number][] = []
  for (const line of lines) {
    let r: any
    try { r = JSON.parse(line) } catch { continue }
    if (r.t === 'meta') {
      meta = {
        cwd: sawMeta ? meta.cwd : (r.cwd ?? ''),
        model: r.model ?? 'deepseek-v4-flash',
        providerId: r.providerId,
        thinking: r.thinking ?? false,
        effortLevel: r.effortLevel,
        permMode: r.permMode ?? 'default',
      }
      sawMeta = true
    }
    else if (r.t === 'msg') {
      messages.push(r.m)
      messageTurnIds.push(typeof r.turn === 'number' ? r.turn : undefined)
      if (typeof r.turn === 'number' && r.turn > maxTurnId) maxTurnId = r.turn
    }
    else if (r.t === 'usage') usages.push({ usage: r.usage, model: r.model })
    else if (r.t === 'fs') fileState = r.entries // 最后一条覆盖，得到最新快照
    else if (r.t === 'compact') { messages = []; messageTurnIds = [] } // 压缩重置：只清消息，usage/fs 不受影响
    else if (r.t === 'rewind') {
      const cut = messageTurnIds.findIndex(t => t === r.toTurnId)
      if (cut >= 0) { messages = messages.slice(0, cut); messageTurnIds = messageTurnIds.slice(0, cut) }
    }
  }
  const sani = sanitizeDanglingToolCalls(messages, messageTurnIds)
  return { meta, messages: sani.messages, usages, fileState, messageTurnIds: sani.turnIds, maxTurnId }
}

/** 崩溃/截断可能留下没有 tool 结果的 assistant tool_calls，恢复后会被 API 拒收；补合成结果保持可恢复。同步维护 turnIds 对齐。 */
function sanitizeDanglingToolCalls(messages: any[], turnIds: (number | undefined)[]): { messages: any[]; turnIds: (number | undefined)[] } {
  const answered = new Set<string>()
  for (const m of messages) if (m?.role === 'tool' && m.tool_call_id) answered.add(m.tool_call_id)
  const out: any[] = []
  const outTurns: (number | undefined)[] = []
  messages.forEach((m, i) => {
    out.push(m); outTurns.push(turnIds[i])
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc?.id && !answered.has(tc.id)) { out.push({ role: 'tool', tool_call_id: tc.id, content: '（中断，无结果）' }); outTurns.push(undefined) }
      }
    }
  })
  return { messages: out, turnIds: outTurns }
}

/** 列出某 cwd 下的会话，新到旧，附首条 user 消息预览。损坏文件跳过。 */
export function listSessions(cwd: string, dir: string = DEFAULT_DIR): SessionInfo[] {
  let files: string[]
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')) } catch { return [] }
  const out: SessionInfo[] = []
  for (const f of files) {
    const full = path.join(dir, f)
    try {
      const loaded = loadSession(full)
      if (loaded.meta.cwd !== cwd) continue
      const firstUser = loaded.messages.find(m => m.role === 'user')
      out.push({
        file: full,
        mtimeMs: fs.statSync(full).mtimeMs,
        preview: typeof firstUser?.content === 'string' ? firstUser.content.slice(0, 60) : '(无预览)',
      })
    } catch { continue }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}
