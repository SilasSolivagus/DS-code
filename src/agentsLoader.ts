// src/agentsLoader.ts —— L-040 B 用户自定义子代理加载（CC 生态兼容）。
// 解析 CC frontmatter（yaml）→ AgentDefinition，扫 .claude/agents + .deepcode/agents 合并。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parse as parseYaml } from 'yaml'
import type { AgentDefinition } from './tools/agentTypes.js'
import { BUILTIN_AGENTS } from './tools/agentTypes.js'
import { activeProvider, belongsToProvider, type ProviderPreset } from './providers.js'

/** 切 frontmatter（`---\n…\n---`）+ body。无 frontmatter 或坏 YAML → data 空、body 原文（容错对齐 CC）。 */
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { data: {}, body: raw }
  let data: Record<string, unknown> = {}
  try {
    const parsed = parseYaml(m[1])
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>
  } catch { /* 坏 YAML → 空（容错） */ }
  return { data, body: raw.slice(m[0].length) }
}

/** tools/disallowedTools 解析（对齐 CC）：逗号串/YAML 数组；`*`→undefined(全部)；省略→undefined；空→[]。 */
export function parseToolList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  let arr: string[]
  if (typeof value === 'string') arr = value.split(',').map(s => s.trim()).filter(Boolean)
  else if (Array.isArray(value)) arr = value.filter((x): x is string => typeof x === 'string').flatMap(s => s.split(',')).map(s => s.trim()).filter(Boolean)
  else return undefined
  if (arr.includes('*')) return undefined
  return arr
}

/** CC 模型档 → deepcode 子调用词汇（inherit/flash/smart/具体 id）。加载时归一，运行时由 resolveSubModel 落地。
 *  能力档别名映射当前 provider；归属 active provider 的具体 id（含未来新档）透传；跨 provider/未知 → inherit。 */
export function resolveAgentModelAlias(model: unknown, preset: ProviderPreset = activeProvider()): string | undefined {
  if (typeof model !== 'string' || !model.trim()) return undefined
  const raw = model.trim()
  const lower = raw.toLowerCase()
  if (lower === 'inherit') return 'inherit'
  if (lower === 'smart' || lower === 'opus' || lower === 'sonnet' || lower === 'best') return 'smart'
  if (lower === 'fast' || lower === 'flash' || lower === 'haiku') return 'flash'
  if (belongsToProvider(preset, raw)) return raw // active provider 具体 id（含 v4.1/glm-5.3 前向兼容）
  return 'inherit'                                // 跨 provider / 未知 → 安全落父
}

/** 单 agent markdown → AgentDefinition。缺 name/description → null（对齐 CC：静默/记错跳过）。
 *  进阶字段（memory/isolation/mcpServers/hooks/skills/permissionMode/effort/background/initialPrompt/color）解析层忽略。 */
export function parseAgentFile(raw: string): AgentDefinition | null {
  const { data, body } = parseFrontmatter(raw)
  const name = data.name
  if (typeof name !== 'string' || !name.trim()) return null
  const description = data.description
  if (typeof description !== 'string' || !description.trim()) return null
  const systemPrompt = body.trim()
  return {
    agentType: name.trim(),
    whenToUse: description.replace(/\\n/g, '\n'), // 对齐 CC YAML \n 反转义
    tools: parseToolList(data.tools),
    disallowedTools: parseToolList(data.disallowedTools),
    model: resolveAgentModelAlias(data.model),
    getSystemPrompt: () => systemPrompt,
  }
}

/** 扫四目录（builtin<user<project，同级 .deepcode>.claude）的 *.md，解析成 AgentDefinition 列表（低→高优先序）。
 *  目录不存在/单文件坏 → 跳过（容错，对齐 loadCustomCommands）。home 可注入便于测。 */
export function loadCustomAgents(cwd: string, home: string = os.homedir()): AgentDefinition[] {
  const dirs = [
    path.join(home, '.claude', 'agents'),
    path.join(home, '.deepcode', 'agents'),
    path.join(cwd, '.claude', 'agents'),
    path.join(cwd, '.deepcode', 'agents'),
  ]
  const out: AgentDefinition[] = []
  for (const dir of dirs) {
    let files: string[] = []
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')) } catch { continue }
    for (const f of files) {
      try {
        const def = parseAgentFile(fs.readFileSync(path.join(dir, f), 'utf8'))
        if (def) out.push(def)
      } catch { /* 单文件坏跳过 */ }
    }
  }
  return out
}

/** builtin + custom 合并：Map<agentType> 按序 set，custom 覆盖同名 builtin（last-wins）。 */
export function mergeAgents(builtin: AgentDefinition[], custom: AgentDefinition[]): AgentDefinition[] {
  const m = new Map<string, AgentDefinition>()
  for (const a of [...builtin, ...custom]) m.set(a.agentType, a)
  return [...m.values()]
}

/** 启动时解析最终 agent 注册表（内建 + 自定义合并）。 */
export function resolveAgents(cwd: string, home?: string): AgentDefinition[] {
  return mergeAgents(BUILTIN_AGENTS, loadCustomAgents(cwd, home))
}
