// src/config.ts
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export interface Settings {
  permissions: { allow: string[] }
}

const DIR = path.join(os.homedir(), '.deepcode')
const FILE = path.join(DIR, 'settings.json')

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return { permissions: { allow: raw?.permissions?.allow ?? [] } }
  } catch {
    return { permissions: { allow: [] } }
  }
}

export function saveSettings(s: Settings): void {
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2))
}
