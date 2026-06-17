// src/skillsLoader.ts —— CC 式 skills 发现/解析（复用 agentsLoader 的 frontmatter/工具/模型解析）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parseFrontmatter, parseToolList, resolveAgentModelAlias } from './agentsLoader.js'

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
      skillDir, isLegacy: true, body,
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
    body,
  }
}

function loadSkillsFromDir(dir: string): SkillDefinition[] {
  let names: string[] = []
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) } catch { return [] }
  const out: SkillDefinition[] = []
  for (const name of names) {
    const file = path.join(dir, name, 'SKILL.md')
    try {
      const def = parseSkillFile(fs.readFileSync(file, 'utf8'), path.join(dir, name), name, false)
      if (def) out.push(def)
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
      if (def) out.push(def)
    } catch { /* 单文件坏跳过 */ }
  }
  return out
}

/** 发现序低→高优先（last-wins）：legacy commands < skills；home < project；.claude < .deepcode。 */
export function loadSkills(cwd: string, home: string = os.homedir()): SkillDefinition[] {
  const ordered: SkillDefinition[] = [
    ...loadLegacyFromDir(path.join(home, '.deepcode', 'commands')),
    ...loadLegacyFromDir(path.join(cwd, '.deepcode', 'commands')),
    ...loadSkillsFromDir(path.join(home, '.claude', 'skills')),
    ...loadSkillsFromDir(path.join(home, '.deepcode', 'skills')),
    ...loadSkillsFromDir(path.join(cwd, '.claude', 'skills')),
    ...loadSkillsFromDir(path.join(cwd, '.deepcode', 'skills')),
  ]
  const m = new Map<string, SkillDefinition>()
  for (const s of ordered) m.set(s.name, s) // last-wins
  return [...m.values()]
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
  out = out.replaceAll('$ARGUMENTS', args)
  return out
}
