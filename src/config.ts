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

export interface SkillsConfig {
  /** 扫哪些目录家族；缺省 = 两者都扫（对齐 CC 全扫）。
   *  'claude' = <home|proj>/.claude/skills；'deepcode' = <home|proj>/.deepcode/{skills,commands}。
   *  ['deepcode'] 一刀切跳过所有 .claude 源（干掉 ~/.claude 的 gstack 灌入）。 */
  sources?: Array<'claude' | 'deepcode'>
  /** 按精确 skill 名排除（不加载→不在任何清单、不可调用）。 */
  deny?: string[]
  /** 模型清单 + Skill 工具 description 的总字符预算；缺省 8000（对齐 CC）。 */
  listingBudgetChars?: number
}

export interface WebSearchSettings {
  bocha?: { apiKey?: string }
  tavily?: { apiKey?: string }
  /** 向后兼容字段，双源并查不使用。 */
  provider?: string
}

export interface Settings {
  permissions: { allow: string[]; deny?: string[] }
  /** 自动 compact 触发阈值（上次请求的 prompt_tokens 超过即触发） */
  compactTokens: number
  /** 本会话花费提醒阈值（CNY，状态行变色一次） */
  costWarnCNY: number
  /** 工具结果字符级兜底上限，超出截断后再回灌 messages（保护上下文/前缀缓存）。缺省 100,000。 */
  maxToolResultChars: number
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
  /** Skills 发现范围 + 清单预算配置（opt-in；缺省对齐 CC 全扫全可调用）。 */
  skills?: SkillsConfig
  /** WebSearch 双源（bocha/tavily）配置；apiKey env 可覆盖（BOCHA_API_KEY/TAVILY_API_KEY）。 */
  webSearch?: WebSearchSettings
  /** hook URL 白名单（SSRF）：undefined=不限制；[]=全禁；非空=须匹配通配模式。 */
  allowedHttpHookUrls?: string[]
  /** http hook header env 插值的全局白名单；设了则与每个 hook 自身 allowedEnvVars 取交集。 */
  httpHookAllowedEnvVars?: string[]
}

const DIR = path.join(os.homedir(), '.deepcode')
const FILE = path.join(DIR, 'settings.json')

/** settings.json 绝对路径（ConfigChange 等 payload 的 file_path）。 */
export const SETTINGS_FILE = FILE

/** 后台任务输出落盘目录（~/.deepcode/tasks） */
export const TASKS_DIR = path.join(os.homedir(), '.deepcode', 'tasks')

/** todo 任务清单落盘根目录（~/.deepcode/task-lists/<sessionId>/<id>.json） */
export const TASK_LISTS_DIR = path.join(os.homedir(), '.deepcode', 'task-lists')

/** 后台任务输出日志路径 */
export function taskOutputPath(id: string): string {
  return path.join(TASKS_DIR, id + '.log')
}

export function parsePermissions(raw: any): { allow: string[]; deny?: string[] } {
  const allow: string[] = Array.isArray(raw?.permissions?.allow)
    ? raw.permissions.allow.filter((s: unknown): s is string => typeof s === 'string')
    : []
  const out: { allow: string[]; deny?: string[] } = { allow }
  const rawDeny = raw?.permissions?.deny
  if (Array.isArray(rawDeny)) {
    const deny = rawDeny.filter((d: unknown): d is string => typeof d === 'string').map((d: string) => d.trim()).filter((d: string) => d.length > 0)
    if (deny.length) out.deny = deny
  }
  return out
}

export function loadSettings(): Settings {
  let raw: any = {}
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch {
    // 用默认
  }
  return {
    permissions: parsePermissions(raw),
    compactTokens: raw?.compactTokens ?? 200_000,
    costWarnCNY: raw?.costWarnCNY ?? raw?.costWarnUSD ?? 15,
    maxToolResultChars: raw?.maxToolResultChars ?? 100_000,
    model: raw?.model,
    baseURL: raw?.baseURL,
    apiKey: raw?.apiKey,
    inline: raw?.inline,
    hooks: parseHooksConfig(raw?.hooks),
    mcpServers: parseMcpServers(raw?.mcpServers),
    skills: parseSkillsConfig(raw?.skills),
    webSearch: parseWebSearchConfig(raw?.webSearch),
    allowedHttpHookUrls: parseStringArray(raw?.allowedHttpHookUrls),
    httpHookAllowedEnvVars: parseStringArray(raw?.httpHookAllowedEnvVars),
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

/** 宽松解析 settings.skills：sources 仅留 'claude'|'deepcode'；deny 留 trim 后非空 string；
 *  listingBudgetChars 须正整数。任一字段非法即丢弃该字段（落默认）。非对象 → undefined。 */
export function parseSkillsConfig(raw: unknown): SkillsConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const out: SkillsConfig = {}
  if (Array.isArray(r.sources)) {
    const valid = r.sources.filter((s): s is 'claude' | 'deepcode' => s === 'claude' || s === 'deepcode')
    if (valid.length) out.sources = valid
  }
  if (Array.isArray(r.deny)) {
    const valid = r.deny.filter((d): d is string => typeof d === 'string').map(d => d.trim()).filter(d => d.length > 0)
    if (valid.length) out.deny = valid
  }
  if (typeof r.listingBudgetChars === 'number' && Number.isInteger(r.listingBudgetChars) && r.listingBudgetChars > 0) {
    out.listingBudgetChars = r.listingBudgetChars
  }
  return out
}

/** 宽松解析 settings.webSearch：bocha/tavily 须为含非空 string apiKey 的对象才留；provider 留作向后兼容。非对象→undefined。 */
export function parseWebSearchConfig(raw: unknown): WebSearchSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const out: WebSearchSettings = {}
  const pick = (v: unknown): { apiKey: string } | undefined => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
    const k = (v as Record<string, unknown>).apiKey
    return typeof k === 'string' && k ? { apiKey: k } : undefined
  }
  const b = pick(r.bocha); if (b) out.bocha = b
  const t = pick(r.tavily); if (t) out.tavily = t
  if (typeof r.provider === 'string') out.provider = r.provider
  return Object.keys(out).length ? out : undefined
}

/** 解析 string[]：过滤非 string、trim、去空。非数组 → undefined；空数组保留为 []（语义区分）。 */
export function parseStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.filter((s): s is string => typeof s === 'string').map(s => s.trim()).filter(s => s.length > 0)
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
