// src/config.ts
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { HOOK_EVENTS, type HooksConfig, type HookEvent, runHooks } from './hooks.js'
import { loadLayeredSettings } from './settingsLayers.js'
import { parseMemoryConfig } from './memdir/memoryConfig.js'
import type { CustomProvider, ModelMeta } from './providers.js'

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
  /** 自动 compact 触发阈值（上次请求的 prompt_tokens 超过即触发；undefined = 走派生阈值） */
  compactTokens?: number
  /** 本会话花费提醒阈值（CNY，状态行变色一次） */
  costWarnCNY: number
  /** 工具结果字符级兜底上限，超出截断后再回灌 messages（保护上下文/前缀缓存）。缺省 100,000。 */
  maxToolResultChars: number
  /** 启动默认模型（undefined = 内置缺省 deepseek-v4-flash） */
  model?: string
  /** 输出风格名（undefined = 不注入特殊风格；'default' 同) */
  outputStyle?: string
  /** 自定义 API baseURL（undefined = https://api.deepseek.com） */
  baseURL?: string
  /** DeepSeek API key（首跑向导写入；env DEEPSEEK_API_KEY 优先级更高） */
  apiKey?: string
  /** active provider 选择（缺省 deepseek）。仅信任 user scope（project 剥离，见 settingsLayers）。 */
  provider?: 'deepseek' | 'glm' | 'custom'
  /** per-provider 覆盖（apiKey）+ custom 后端定义。仅信任 user scope。 */
  providers?: {
    deepseek?: { apiKey?: string }
    glm?: { apiKey?: string }
    custom?: CustomProvider
  }
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
  /** 记忆子系统配置（缺省全默认，见 memoryConfig.ts）。 */
  memory?: import('./memdir/memoryConfig.js').MemoryConfig
  /** 主题名（undefined = 运行期 Provider 兜底 dark；见 src/tui/theme.ts THEMES）。 */
  theme?: string
  /** 用户自设状态栏命令：执行取 stdout 附加进状态栏。仅信任 user scope（DANGEROUS_TOP_KEYS 剥离 project）。 */
  statusLineCommand?: string
  /** git worktree 配置（isolation:"worktree" / EnterWorktree 用；全层生效不剥离）。 */
  worktree?: { symlinkDirectories?: string[]; sparsePaths?: string[] }
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

/** 单文件原始 user scope 解析（写路径用；= 旧 loadSettings 实现）。 */
export function loadRawUserSettings(): Settings {
  let raw: any = {}
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { /* 用默认 */ }
  return {
    permissions: parsePermissions(raw),
    compactTokens: raw?.compactTokens,
    costWarnCNY: raw?.costWarnCNY ?? raw?.costWarnUSD ?? 15,
    maxToolResultChars: raw?.maxToolResultChars ?? 100_000,
    model: raw?.model, baseURL: raw?.baseURL, apiKey: raw?.apiKey, inline: raw?.inline,
    hooks: parseHooksConfig(raw?.hooks), mcpServers: parseMcpServers(raw?.mcpServers),
    skills: parseSkillsConfig(raw?.skills), webSearch: parseWebSearchConfig(raw?.webSearch),
    allowedHttpHookUrls: parseStringArray(raw?.allowedHttpHookUrls),
    httpHookAllowedEnvVars: parseStringArray(raw?.httpHookAllowedEnvVars),
    memory: parseMemoryConfig(raw?.memory),
    provider: raw?.provider === 'glm' || raw?.provider === 'custom' || raw?.provider === 'deepseek' ? raw.provider : undefined,
    providers: parseProvidersConfig(raw?.providers),
    outputStyle: raw?.outputStyle,
    theme: raw?.theme,
    statusLineCommand: raw?.statusLineCommand,
    worktree: parseWorktreeConfig(raw?.worktree),
  }
}

/** 运行时合并配置（分层）。所有只读消费者用此。 */
export function loadSettings(cwd?: string, flagPath?: string): Settings {
  return loadLayeredSettings(cwd, flagPath).settings
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

/** 宽松解析 settings.providers：deepseek/glm 取 {apiKey:string}；custom 须有 baseURL + models.fast/smart。
 *  custom.dialect 非 deepseek/glm/openai 则丢弃。非对象 → undefined。 */
export function parseProvidersConfig(raw: unknown): Settings['providers'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const out: NonNullable<Settings['providers']> = {}
  const keyOnly = (v: unknown): { apiKey?: string } | undefined => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
    const k = (v as Record<string, unknown>).apiKey
    return typeof k === 'string' && k ? { apiKey: k } : undefined
  }
  const ds = keyOnly(r.deepseek); if (ds) out.deepseek = ds
  const glm = keyOnly(r.glm); if (glm) out.glm = glm
  const c = r.custom
  if (c && typeof c === 'object' && !Array.isArray(c)) {
    const cc = c as Record<string, any>
    const models = cc.models
    if (typeof cc.baseURL === 'string' && cc.baseURL &&
        models && typeof models === 'object' &&
        typeof models.fast === 'string' && typeof models.smart === 'string') {
      const custom: CustomProvider = { baseURL: cc.baseURL, models: { fast: models.fast, smart: models.smart } }
      if (typeof cc.apiKeyEnv === 'string') custom.apiKeyEnv = cc.apiKeyEnv
      if (typeof cc.apiKey === 'string') custom.apiKey = cc.apiKey
      if (cc.dialect === 'deepseek' || cc.dialect === 'glm' || cc.dialect === 'openai') custom.dialect = cc.dialect
      if (cc.meta && typeof cc.meta === 'object') custom.meta = cc.meta as Record<string, ModelMeta>
      if (cc.defaultMeta && typeof cc.defaultMeta === 'object') custom.defaultMeta = cc.defaultMeta as ModelMeta
      out.custom = custom
    }
  }
  return Object.keys(out).length ? out : undefined
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

/** 宽松解析 settings.worktree：symlinkDirectories/sparsePaths 各取 string[]。两者均无则返 undefined。 */
export function parseWorktreeConfig(raw: unknown): Settings['worktree'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const out: NonNullable<Settings['worktree']> = {}
  const sd = parseStringArray(r.symlinkDirectories); if (sd) out.symlinkDirectories = sd
  const sp = parseStringArray(r.sparsePaths); if (sp) out.sparsePaths = sp
  return (out.symlinkDirectories || out.sparsePaths) ? out : undefined
}

/** 解析 string[]：过滤非 string、trim、去空。非数组 → undefined；空数组保留为 []（语义区分）。 */
export function parseStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.filter((s): s is string => typeof s === 'string').map(s => s.trim()).filter(s => s.length > 0)
}

/** 只写 user scope 原始文件（分层下唯一写目标，防洗白）。 */
export function saveRawUserSettings(s: Settings): void {
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2))
  try { fs.chmodSync(FILE, 0o600) } catch { /* 尽力而为 */ }
}

export function hasApiKey(): boolean {
  return !!(process.env.DEEPSEEK_API_KEY ?? loadRawUserSettings().apiKey)
}

export function saveApiKey(key: string): void {
  const s = loadRawUserSettings()
  const hadKey = !!s.apiKey
  s.apiKey = key || undefined
  saveRawUserSettings(s)
  try { fs.chmodSync(FILE, 0o600) } catch { /* 尽力 */ }
  if (s.hooks) void runHooks('Setup', { hook_event_name: 'Setup', cwd: process.cwd(), trigger: hadKey ? 'maintenance' : 'init' }, s.hooks).catch(() => {})
}

/** 往 user scope allow 列表加规则（raw RMW，不触其它 scope）。返回更新后的 user allow 数组。 */
export function addUserAllowRule(rule: string): string[] {
  const s = loadRawUserSettings()
  if (!s.permissions.allow.includes(rule)) s.permissions.allow.push(rule)
  saveRawUserSettings(s)
  return s.permissions.allow
}

/** 按 user scope allow 索引删除一条；返回被删规则或 undefined。 */
export function removeUserAllowRule(index: number): string | undefined {
  const s = loadRawUserSettings()
  if (s.permissions.allow[index] === undefined) return undefined
  const [removed] = s.permissions.allow.splice(index, 1)
  saveRawUserSettings(s)
  return removed
}

/** 读 user scope allow 列表（/permissions 显示用，保 rm 索引一致）。 */
export function listUserAllowRules(): string[] {
  return loadRawUserSettings().permissions.allow
}

/** 读 user scope deny 列表（/permissions 显示用）。 */
export function listUserDenyRules(): string[] {
  return loadRawUserSettings().permissions.deny ?? []
}

/** 按值从 user scope allow 删除（合并视图索引不对应 user 文件行，故按值）。删到返 true。 */
export function removeUserAllowRuleByValue(value: string): boolean {
  const s = loadRawUserSettings()
  const i = s.permissions.allow.indexOf(value)
  if (i < 0) return false
  s.permissions.allow.splice(i, 1)
  saveRawUserSettings(s)
  return true
}

/** 按值从 user scope deny 删除。删到返 true。 */
export function removeUserDenyRuleByValue(value: string): boolean {
  const s = loadRawUserSettings()
  const deny = s.permissions.deny
  if (!deny) return false
  const i = deny.indexOf(value)
  if (i < 0) return false
  deny.splice(i, 1)
  saveRawUserSettings(s)
  return true
}
