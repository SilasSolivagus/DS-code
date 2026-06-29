// src/tipsState.ts — app 管理的可变运行态，独立于用户手写 settings.json
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STATE_FILE = path.join(os.homedir(), '.deepcode', 'state.json')

export interface AppState {
  startupCount: number
  tipsHistory: Record<string, number>
}

export function loadAppState(file: string = STATE_FILE): AppState {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const startupCount = typeof raw?.startupCount === 'number' && raw.startupCount >= 0 ? Math.floor(raw.startupCount) : 0
    const tipsHistory: Record<string, number> =
      raw?.tipsHistory && typeof raw.tipsHistory === 'object' && !Array.isArray(raw.tipsHistory)
        ? Object.fromEntries(Object.entries(raw.tipsHistory).filter(([, v]) => typeof v === 'number') as [string, number][])
        : {}
    return { startupCount, tipsHistory }
  } catch {
    return { startupCount: 0, tipsHistory: {} }
  }
}

export function saveAppState(state: AppState, file: string = STATE_FILE): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(state, null, 2))
  } catch { /* 持久化失败不阻断启动 */ }
}
