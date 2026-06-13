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
  }
}

export function saveSettings(s: Settings): void {
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2))
}
