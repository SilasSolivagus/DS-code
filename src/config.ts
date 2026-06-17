// src/config.ts
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { HOOK_EVENTS, type HooksConfig, type HookEvent, runHooks } from './hooks.js'

export interface McpStdioServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface Settings {
  permissions: { allow: string[] }
  /** 自动 compact 触发阈值（上次请求的 prompt_tokens 超过即触发） */
  compactTokens: number
  /** 本会话花费提醒阈值（USD，状态行变色一次） */
  costWarnUSD: number
  /** 启动默认模型（undefined = 内置缺省 deepseek-v4-flash） */
  model?: string
  /** 自定义 API baseURL（undefined = https://api.deepseek.com） */
  baseURL?: string
  /** DeepSeek API key（首跑向导写入；env DEEPSEEK_API_KEY 优先级更高） */
  apiKey?: string
  /** 启动用内联模式（退回非全屏 TUI；env DEEPCODE_INLINE=1 / CLI --inline 优先） */
  inline?: boolean
  /** hooks 生命周期配置（会话启动快照；见 src/hooks.ts） */
  hooks?: HooksConfig
  /** MCP server 配置（stdio）。键=server 名，值=启动方式。 */
  mcpServers?: Record<string, McpStdioServerConfig>
}

const DIR = path.join(os.homedir(), '.deepcode')
const FILE = path.join(DIR, 'settings.json')

/** settings.json 绝对路径（ConfigChange 等 payload 的 file_path）。 */
export const SETTINGS_FILE = FILE

/** 后台任务输出落盘目录（~/.deepcode/tasks） */
export const TASKS_DIR = path.join(os.homedir(), '.deepcode', 'tasks')

/** 后台任务输出日志路径 */
export function taskOutputPath(id: string): string {
  return path.join(TASKS_DIR, id + '.log')
}

export function loadSettings(): Settings {
  let raw: any = {}
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch {
    // 用默认
  }
  return {
    permissions: { allow: raw?.permissions?.allow ?? [] },
    compactTokens: raw?.compactTokens ?? 200_000,
    costWarnUSD: raw?.costWarnUSD ?? 2,
    model: raw?.model,
    baseURL: raw?.baseURL,
    apiKey: raw?.apiKey,
    inline: raw?.inline,
    hooks: parseHooksConfig(raw?.hooks),
    mcpServers: parseMcpServers(raw?.mcpServers),
  }
}

/** 宽松解析 settings.hooks：只留已知事件键、matcher 为对象数组、hooks 为对象数组的条目。非对象→undefined。 */
export function parseHooksConfig(raw: unknown): HooksConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: HooksConfig = {}
  const known = new Set<string>(HOOK_EVENTS)
  for (const [event, matchers] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(event) || !Array.isArray(matchers)) continue
    const valid = matchers.filter(
      (m): m is { matcher?: string; hooks: unknown[] } =>
        !!m && typeof m === 'object' && Array.isArray((m as any).hooks) &&
        (m as any).hooks.every((h: any) => h && typeof h === 'object' && typeof h.type === 'string'),
    )
    if (valid.length) (out as any)[event as HookEvent] = valid
  }
  return Object.keys(out).length ? out : undefined
}

/** 宽松解析 settings.mcpServers：只留 command 为非空字符串的条目；args 过滤非字符串；env 须为对象。 */
export function parseMcpServers(raw: unknown): Record<string, McpStdioServerConfig> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, McpStdioServerConfig> = {}
  for (const [name, cfg] of Object.entries(raw as Record<string, unknown>)) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue
    const c = cfg as Record<string, unknown>
    if (typeof c.command !== 'string' || !c.command) continue
    out[name] = {
      command: c.command,
      args: Array.isArray(c.args) ? (c.args.filter(a => typeof a === 'string') as string[]) : undefined,
      env: c.env && typeof c.env === 'object' && !Array.isArray(c.env) ? (c.env as Record<string, string>) : undefined,
    }
  }
  return Object.keys(out).length ? out : undefined
}

export function saveSettings(s: Settings): void {
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2))
}

export function hasApiKey(): boolean {
  return !!(process.env.DEEPSEEK_API_KEY ?? loadSettings().apiKey)
}

export function saveApiKey(key: string): void {
  const s = loadSettings()
  const hadKey = !!s.apiKey // 保存前是否已有落盘 key → 区分 init/maintenance
  s.apiKey = key || undefined
  saveSettings(s)
  try { fs.chmodSync(FILE, 0o600) } catch { /* 尽力而为 */ }
  // Setup hook：首跑向导写 key=init；后续改 key=maintenance。fire-and-forget，hook 故障不阻断。
  if (s.hooks) void runHooks('Setup', { hook_event_name: 'Setup', cwd: process.cwd(), trigger: hadKey ? 'maintenance' : 'init' }, s.hooks).catch(() => {})
}
