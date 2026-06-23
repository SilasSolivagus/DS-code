// src/outputStyles.ts —— 输出风格：内置两套 + 用户 ~/.deepcode/output-styles/*.md
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseFrontmatter } from './agentsLoader.js'

export interface OutputStyle {
  name: string
  description: string
  prompt: string
  /** true=追加在工作守则后；false=替换工作守则块。 */
  keepCodingInstructions: boolean
}

export const BUILTIN_OUTPUT_STYLES: OutputStyle[] = [
  {
    name: 'Explanatory',
    description: '在动手的同时解释实现选择与代码库模式',
    keepCodingInstructions: true,
    prompt: '# 输出风格：解说式\n在完成任务的同时，简要解释你为什么这样实现：涉及的代码库模式、设计权衡、以及该改动如何与现有结构衔接。解释穿插在工作中，保持简洁，不打断交付节奏。',
  },
  {
    name: 'Learning',
    description: '教学式：边做边教，给出可学习的要点',
    keepCodingInstructions: true,
    prompt: '# 输出风格：教学式\n以教学心态工作：在关键步骤标出「为什么这么做」「换个场景该怎么选」，并在合适处留一两个供用户思考或动手的小练习。目标是让用户在你完成任务的同时也学到东西，但不牺牲交付的正确性与简洁。',
  },
]

function loadUserStyles(home: string): OutputStyle[] {
  const dir = path.join(home, '.deepcode', 'output-styles')
  let names: string[] = []
  try { names = fs.readdirSync(dir).filter(f => f.endsWith('.md')) } catch { return [] }
  const out: OutputStyle[] = []
  for (const f of names) {
    try {
      const { data, body } = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'))
      const prompt = body.trim()
      if (!prompt) continue
      const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : f.replace(/\.md$/, '')
      const description = typeof data.description === 'string' ? data.description.trim() : ''
      const keep = data.keepCodingInstructions !== false // 默认 true
      out.push({ name, description, prompt, keepCodingInstructions: keep })
    } catch { /* 坏文件跳过 */ }
  }
  return out
}

/** 内置 + 用户样式（用户同名覆盖内置）。 */
export function loadOutputStyles(home: string = os.homedir()): OutputStyle[] {
  const user = loadUserStyles(home)
  const m = new Map<string, OutputStyle>()
  for (const s of BUILTIN_OUTPUT_STYLES) m.set(s.name.toLowerCase(), s)
  for (const s of user) m.set(s.name.toLowerCase(), s)
  return [...m.values()]
}

/** name 解析样式；'default'/undefined/未找到 → undefined（= 不注入，对齐 default 空段）。 */
export function resolveOutputStyle(name: string | undefined, styles: OutputStyle[]): OutputStyle | undefined {
  if (!name || name.toLowerCase() === 'default') return undefined
  return styles.find(s => s.name.toLowerCase() === name.toLowerCase())
}
