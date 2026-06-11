// src/session.ts
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export interface SessionMeta {
  cwd: string
  model: string
  thinking: boolean
  permMode: string
}

export interface UsageRecord {
  usage: { prompt_tokens: number; completion_tokens: number; prompt_cache_hit_tokens: number }
  model: string
}

export interface SessionHandle {
  file: string
  appendMessage(m: any): void
  appendUsage(usage: UsageRecord['usage'], model: string): void
  appendFileState(entries: [string, number][]): void
}

export interface LoadedSession {
  meta: SessionMeta
  messages: any[]
  usages: UsageRecord[]
  fileState: [string, number][]
}

export interface SessionInfo {
  file: string
  mtimeMs: number
  preview: string
}

const DEFAULT_DIR = path.join(os.homedir(), '.deepcode', 'sessions')

function makeHandle(file: string): SessionHandle {
  const append = (obj: any) => fs.appendFileSync(file, JSON.stringify(obj) + '\n')
  return {
    file,
    appendMessage: m => append({ t: 'msg', m }),
    appendUsage: (usage, model) => append({ t: 'usage', usage, model }),
    appendFileState: entries => append({ t: 'fs', entries }),
  }
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
  const messages: any[] = []
  const usages: UsageRecord[] = []
  let fileState: [string, number][] = []
  for (const line of lines) {
    let r: any
    try { r = JSON.parse(line) } catch { continue }
    if (r.t === 'meta') meta = { cwd: r.cwd, model: r.model, thinking: r.thinking, permMode: r.permMode }
    else if (r.t === 'msg') messages.push(r.m)
    else if (r.t === 'usage') usages.push({ usage: r.usage, model: r.model })
    else if (r.t === 'fs') fileState = r.entries // 最后一条覆盖，得到最新快照
  }
  return { meta, messages, usages, fileState }
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
