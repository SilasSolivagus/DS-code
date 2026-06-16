// src/sessionEnv.ts —— CC 式 session 环境文件机制（对齐 ~/Desktop/src/utils/sessionEnvironment.ts）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { HookEvent } from './hooks.js'

/** 默认 session-env 根目录（按 sessionId 隔离，不跨会话）。 */
export const DEFAULT_SESSION_ENV_BASE = path.join(os.homedir(), '.deepcode', 'session-env')

/** 仅这四类事件的 command hook 会被注入 DEEPCODE_ENV_FILE（对齐 CC）。 */
export const ENV_FILE_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>([
  'Setup', 'SessionStart', 'CwdChanged', 'FileChanged',
])

/** 拼接优先级：小者先注入（被大者覆盖）。对齐 CC HOOK_ENV_PRIORITY。 */
const PRIORITY: Record<'setup' | 'sessionstart' | 'cwdchanged' | 'filechanged', number> = { setup: 0, sessionstart: 1, cwdchanged: 2, filechanged: 3 }
const HOOK_ENV_REGEX = /^(setup|sessionstart|cwdchanged|filechanged)-hook-(\d+)\.sh$/

export function hookEnvFileName(event: HookEvent, index: number): string {
  return `${event.toLowerCase()}-hook-${index}.sh`
}

export function sessionEnvDirFor(sessionId: string, base: string = DEFAULT_SESSION_ENV_BASE): string {
  return path.join(base, sessionId)
}

/** mkdir -p 并返回 session 目录路径（hook 写文件前调用，保证目录存在）。 */
export function ensureSessionEnvDir(sessionId: string, base: string = DEFAULT_SESSION_ENV_BASE): string {
  const dir = sessionEnvDirFor(sessionId, base)
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* 尽力 */ }
  return dir
}

// 单槽缓存（进程内通常仅一个活跃会话；/clear/resume 换 sid 自然 miss）。
let cache: { sid: string; base: string; script: string } | null = null

/** 读 session 目录下所有 hook env 文件，按优先级+index 排序拼成命令前缀（空则空串）。带单槽缓存。 */
export function getSessionEnvScript(sessionId: string | undefined, base: string = DEFAULT_SESSION_ENV_BASE): string {
  if (!sessionId) return ''
  if (cache && cache.sid === sessionId && cache.base === base) return cache.script
  const dir = sessionEnvDirFor(sessionId, base)
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { cache = { sid: sessionId, base, script: '' }; return '' }
  const matched: Array<{ name: string; pri: number; idx: number }> = []
  for (const name of names) {
    const m = HOOK_ENV_REGEX.exec(name)
    if (!m) continue
    matched.push({ name, pri: PRIORITY[m[1] as keyof typeof PRIORITY], idx: Number(m[2]) })
  }
  matched.sort((a, b) => (a.pri - b.pri) || (a.idx - b.idx))
  const parts: string[] = []
  for (const { name } of matched) {
    let content = ''
    try { content = fs.readFileSync(path.join(dir, name), 'utf8').trim() } catch { /* 尽力 */ }
    if (content) parts.push(content)
  }
  const script = parts.join('\n')
  cache = { sid: sessionId, base, script }
  return script
}

/** 清空当前会话的 cwdchanged-* / filechanged-* 文件内容并失效缓存（cwd 变更时调）。 */
export function clearCwdEnvFiles(sessionId: string, base: string = DEFAULT_SESSION_ENV_BASE): void {
  const dir = sessionEnvDirFor(sessionId, base)
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return }
  for (const name of names) {
    if (/^(cwdchanged|filechanged)-hook-\d+\.sh$/.test(name)) {
      try { fs.writeFileSync(path.join(dir, name), '') } catch { /* 尽力 */ }
    }
  }
  invalidateSessionEnvCache(sessionId)
}

/** 失效缓存：不传 sid 清全部；传 sid 仅清匹配槽。 */
export function invalidateSessionEnvCache(sessionId?: string): void {
  if (sessionId === undefined || (cache && cache.sid === sessionId)) cache = null
}
