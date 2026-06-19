// src/tools/configTool.ts —— 4.5 Config 工具：模型可调读写白名单配置键（对齐 CC ConfigTool）。
import { z } from 'zod'
import type { Tool } from './types.js'
import { loadRawUserSettings, saveRawUserSettings, type Settings } from '../config.js'
import { loadLayeredSettings } from '../settingsLayers.js'

type Scalar = string | number | boolean
type CoerceResult = { ok: true; value: Scalar } | { ok: false; error: string }
interface ConfigKey {
  coerce(v: Scalar): CoerceResult
  read(s: Settings): Scalar
  write(raw: Settings, v: Scalar): void
}

const posInt = (v: Scalar): CoerceResult => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isInteger(n) && n > 0 ? { ok: true, value: n } : { ok: false, error: '须为正整数' }
}
const posNum = (v: Scalar): CoerceResult => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? { ok: true, value: n } : { ok: false, error: '须为正数' }
}
const boolCoerce = (v: Scalar): CoerceResult => {
  if (typeof v === 'boolean') return { ok: true, value: v }
  if (v === 'true') return { ok: true, value: true }
  if (v === 'false') return { ok: true, value: false }
  return { ok: false, error: '须为 true 或 false' }
}
const nonEmptyStr = (v: Scalar): CoerceResult => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s ? { ok: true, value: s } : { ok: false, error: '须为非空字符串' }
}

export const CONFIG_KEYS: Record<string, ConfigKey> = {
  model: { coerce: nonEmptyStr, read: s => s.model ?? '(默认)', write: (raw, v) => { raw.model = v as string } },
  compactTokens: { coerce: posInt, read: s => s.compactTokens ?? '(未设，走派生阈值)', write: (raw, v) => { raw.compactTokens = v as number } },
  costWarnCNY: { coerce: posNum, read: s => s.costWarnCNY, write: (raw, v) => { raw.costWarnCNY = v as number } },
  maxToolResultChars: { coerce: posInt, read: s => s.maxToolResultChars, write: (raw, v) => { raw.maxToolResultChars = v as number } },
  inline: { coerce: boolCoerce, read: s => s.inline ?? false, write: (raw, v) => { raw.inline = v as boolean } },
  'skills.listingBudgetChars': {
    coerce: posInt,
    read: s => s.skills?.listingBudgetChars ?? '(默认 8000)',
    write: (raw, v) => { raw.skills = { ...raw.skills, listingBudgetChars: v as number } },
  },
}

/** 受保护键的顶层名（命中 → 明确「受保护」文案，区别于「未知」）。 */
const PROTECTED_TOP = new Set([
  'apiKey', 'baseURL', 'hooks', 'mcpServers', 'permissions', 'webSearch',
  'allowedHttpHookUrls', 'httpHookAllowedEnvVars',
])

const schema = z.object({
  setting: z.string().describe('配置键名：model / compactTokens / costWarnCNY / maxToolResultChars / inline / skills.listingBudgetChars'),
  value: z.union([z.string(), z.number(), z.boolean()]).optional().describe('省略=读取当前值；提供=写入该值'),
})

export const configTool: Tool<typeof schema> = {
  name: 'Config',
  description:
    '读写 deepcode 用户级配置。省略 value=读当前合并值；提供 value=写入 user 配置。' +
    '可用键：model, compactTokens, costWarnCNY, maxToolResultChars, inline, skills.listingBudgetChars。' +
    '敏感/受保护设置（apiKey、baseURL、hooks、mcpServers、permissions、webSearch、SSRF 白名单）不可经此工具修改。',
  inputSchema: schema,
  isReadOnly: false,
  needsPermission: input => (input.value === undefined || !CONFIG_KEYS[input.setting] ? false : `Config(set ${input.setting})`),
  async call(input) {
    const key = CONFIG_KEYS[input.setting]
    if (!key) {
      const base = input.setting.split('.')[0]
      if (PROTECTED_TOP.has(base)) return `错误：'${input.setting}' 不可经 Config 工具修改（敏感/受保护设置）`
      return `错误：未知设置 '${input.setting}'（可用：${Object.keys(CONFIG_KEYS).join(', ')}）`
    }
    if (input.value === undefined) {
      return `${input.setting} = ${key.read(loadLayeredSettings().settings)}`
    }
    const c = key.coerce(input.value)
    if (!c.ok) return `错误：${input.setting} ${c.error}`
    const raw = loadRawUserSettings()
    const prev = key.read(raw)
    key.write(raw, c.value)
    saveRawUserSettings(raw)
    return `已设置 ${input.setting} = ${c.value}（原 ${prev}）`
  },
}
