// src/config.ts
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

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
}

const DIR = path.join(os.homedir(), '.deepcode')
const FILE = path.join(DIR, 'settings.json')

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
  }
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
  s.apiKey = key || undefined
  saveSettings(s)
  try { fs.chmodSync(FILE, 0o600) } catch { /* 尽力而为 */ }
}
