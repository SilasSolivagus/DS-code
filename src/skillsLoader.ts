// src/skillsLoader.ts —— CC 式 skills 发现/解析（复用 agentsLoader 的 frontmatter/工具/模型解析）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parseFrontmatter, parseToolList, resolveAgentModelAlias } from './agentsLoader.js'
import type { SkillsConfig } from './config.js'

export interface SkillDefinition {
  name: string
  description: string
  whenToUse?: string
  context: 'inline' | 'fork'
  agent?: string
  allowedTools?: string[]
  model?: string
  userInvocable: boolean
  modelInvocable: boolean
  argNames?: string[]
  skillDir: string
  isLegacy: boolean
  /** 清单优先级（小=高）：项目=0、user/home=1、legacy=2。formatSkillListing 排序用。 */
  priority: number
  body: string
}

const firstNonEmptyLine = (s: string): string =>
  s.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''

/** 单 skill 文本 → SkillDefinition。正文空 → null。legacy（commands/）：无 frontmatter、user-only、inline、body=全文。 */
export function parseSkillFile(raw: string, skillDir: string, fallbackName: string, isLegacy = false): SkillDefinition | null {
  if (isLegacy) {
    const body = raw.trim()
    if (!body) return null
    return {
      name: fallbackName, description: firstNonEmptyLine(body) || fallbackName,
      context: 'inline', userInvocable: true, modelInvocable: false,
      skillDir, isLegacy: true, priority: 0, body,
    }
  }
  const { data, body: rawBody } = parseFrontmatter(raw)
  const body = rawBody.trim()
  if (!body) return null
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : fallbackName
  const description = typeof data.description === 'string' && data.description.trim()
    ? data.description.trim() : firstNonEmptyLine(body)
  const isFalse = (v: unknown) => v === false || v === 'false'
  const isTrue = (v: unknown) => v === true || v === 'true'
  return {
    name,
    description,
    whenToUse: typeof data['when-to-use'] === 'string' ? (data['when-to-use'] as string).replace(/\\n/g, '\n') : undefined,
    context: data.context === 'fork' ? 'fork' : 'inline',
    agent: typeof data.agent === 'string' ? data.agent.trim() : undefined,
    allowedTools: parseToolList(data['allowed-tools']),
    model: resolveAgentModelAlias(data.model),
    userInvocable: !isFalse(data['user-invocable']),
    modelInvocable: !isTrue(data['disable-model-invocation']),
    argNames: parseToolList(data.arguments),
    skillDir,
    isLegacy: false,
    priority: 0,
    body,
  }
}

function loadSkillsFromDir(dir: string, priority: number): SkillDefinition[] {
  let names: string[] = []
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) } catch { return [] }
  const out: SkillDefinition[] = []
  for (const name of names) {
    const file = path.join(dir, name, 'SKILL.md')
    try {
      const def = parseSkillFile(fs.readFileSync(file, 'utf8'), path.join(dir, name), name, false)
      if (def) out.push({ ...def, priority })
    } catch { /* 缺 SKILL.md / 坏文件跳过 */ }
  }
  return out
}

function loadLegacyFromDir(dir: string): SkillDefinition[] {
  let files: string[] = []
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')) } catch { return [] }
  const out: SkillDefinition[] = []
  for (const f of files) {
    try {
      const def = parseSkillFile(fs.readFileSync(path.join(dir, f), 'utf8'), dir, path.basename(f, '.md'), true)
      if (def) out.push({ ...def, priority: 2 }) // legacy = 2
    } catch { /* 单文件坏跳过 */ }
  }
  return out
}

/** 发现序低→高优先（last-wins）：legacy commands < skills；home < project；.claude < .deepcode。
 *  config.sources 给定时只扫选中家族；config.deny 精确名排除；每条带 priority（listing 排序用）。 */
export function loadSkills(cwd: string, home: string = os.homedir(), config?: SkillsConfig): SkillDefinition[] {
  const sources = config?.sources
  const useClaude = !sources || sources.includes('claude')
  const useDeepcode = !sources || sources.includes('deepcode')
  const ordered: SkillDefinition[] = []
  if (useDeepcode) {
    ordered.push(
      ...loadLegacyFromDir(path.join(home, '.deepcode', 'commands')),
      ...loadLegacyFromDir(path.join(cwd, '.deepcode', 'commands')),
    )
  }
  if (useClaude) ordered.push(...loadSkillsFromDir(path.join(home, '.claude', 'skills'), 1))   // home = 1
  if (useDeepcode) ordered.push(...loadSkillsFromDir(path.join(home, '.deepcode', 'skills'), 1)) // home = 1
  if (useClaude) ordered.push(...loadSkillsFromDir(path.join(cwd, '.claude', 'skills'), 0))     // 项目 = 0
  if (useDeepcode) ordered.push(...loadSkillsFromDir(path.join(cwd, '.deepcode', 'skills'), 0)) // 项目 = 0
  const m = new Map<string, SkillDefinition>()
  for (const s of ordered) m.set(s.name, s) // last-wins
  let result = [...m.values()]
  if (config?.deny && config.deny.length) {
    const deny = new Set(config.deny)
    result = result.filter(s => !deny.has(s.name))
  }
  return result
}

/** skill 正文参数替换：$ARGUMENTS（全文）/ $ARG1.. （空白切分段）/ ${DEEPCODE_SKILL_DIR} / ${DEEPCODE_SESSION_ID}。 */
export function substituteSkillArgs(
  body: string,
  args: string,
  opts: { argNames?: string[]; skillDir: string; sessionId?: string },
): string {
  const parts = args.trim() ? args.trim().split(/\s+/) : []
  let out = body
    .replaceAll('${DEEPCODE_SKILL_DIR}', opts.skillDir)
    .replaceAll('${DEEPCODE_SESSION_ID}', opts.sessionId ?? '')
  out = out.replace(/\$ARG(\d+)/g, (_m, n) => parts[Number(n) - 1] ?? '')
  // 命名参数：$<name>（spec §3.4）；在 $ARGUMENTS 替换前做，避免前缀冲突；用  防止前缀吃字（标识符安全）
  if (opts.argNames && opts.argNames.length > 0) {
    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    for (let i = 0; i < opts.argNames.length; i++) {
      const name = opts.argNames[i]
      out = out.replace(new RegExp('\\$' + escapeRegex(name) + '\\b', 'g'), parts[i] ?? '')
    }
  }
  out = out.replaceAll('$ARGUMENTS', args)
  return out
}
