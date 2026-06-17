import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseFrontmatter, parseToolList, resolveAgentModelAlias, parseAgentFile, loadCustomAgents, mergeAgents, resolveAgents } from '../src/agentsLoader.js'
import { BUILTIN_AGENTS } from '../src/tools/agentTypes.js'

const CC_FILE = `---
name: code-reviewer
description: Review code for bugs\\nand style
tools: Read, Grep
model: sonnet
color: blue
memory: project
---
你是代码审查专家。给出 file:line + 严重度 + 修复。`

describe('parseFrontmatter', () => {
  it('提取 frontmatter + body', () => {
    const { data, body } = parseFrontmatter('---\nname: r\ndescription: d\n---\n正文内容')
    expect(data).toEqual({ name: 'r', description: 'd' })
    expect(body).toBe('正文内容')
  })
  it('YAML 数组', () => {
    const { data } = parseFrontmatter('---\ntools: [Read, Grep]\n---\nx')
    expect(data.tools).toEqual(['Read', 'Grep'])
  })
  it('无 frontmatter → data 空、body 原文', () => {
    expect(parseFrontmatter('就是正文')).toEqual({ data: {}, body: '就是正文' })
  })
  it('坏 YAML → data 空（容错）', () => {
    const { data } = parseFrontmatter('---\n: : bad\n  - [\n---\nb')
    expect(data).toEqual({})
  })
})

describe('parseToolList', () => {
  it('逗号串', () => { expect(parseToolList('Read, Grep, Bash')).toEqual(['Read', 'Grep', 'Bash']) })
  it('数组', () => { expect(parseToolList(['Read', 'Grep'])).toEqual(['Read', 'Grep']) })
  it('* → undefined（全部）', () => { expect(parseToolList('*')).toBeUndefined() })
  it('省略 → undefined（全部）', () => { expect(parseToolList(undefined)).toBeUndefined() })
  it('空串 → []（无工具）', () => { expect(parseToolList('')).toEqual([]) })
})

describe('resolveAgentModelAlias', () => {
  it('inherit', () => { expect(resolveAgentModelAlias('inherit')).toBe('inherit') })
  it('haiku → flash', () => { expect(resolveAgentModelAlias('haiku')).toBe('flash') })
  it('sonnet/opus → inherit', () => {
    expect(resolveAgentModelAlias('sonnet')).toBe('inherit')
    expect(resolveAgentModelAlias('Opus')).toBe('inherit')
  })
  it('未知 claude-* id → inherit 兜底', () => { expect(resolveAgentModelAlias('claude-opus-4-1')).toBe('inherit') })
  it('deepcode 原生透传', () => {
    expect(resolveAgentModelAlias('flash')).toBe('flash')
    expect(resolveAgentModelAlias('deepseek-v4-pro')).toBe('deepseek-v4-pro')
  })
  it('空/非字符串 → undefined', () => {
    expect(resolveAgentModelAlias('')).toBeUndefined()
    expect(resolveAgentModelAlias(undefined)).toBeUndefined()
  })
})

describe('parseAgentFile', () => {
  it('完整 CC 文件 → AgentDefinition（进阶字段忽略不崩）', () => {
    const def = parseAgentFile(CC_FILE)!
    expect(def.agentType).toBe('code-reviewer')
    expect(def.whenToUse).toBe('Review code for bugs\nand style') // \n 反转义
    expect(def.tools).toEqual(['Read', 'Grep'])
    expect(def.model).toBe('inherit') // sonnet 映射
    expect(def.getSystemPrompt()).toContain('代码审查专家')
  })
  it('缺 name → null（静默）', () => {
    expect(parseAgentFile('---\ndescription: d\n---\nx')).toBeNull()
  })
  it('缺 description → null', () => {
    expect(parseAgentFile('---\nname: r\n---\nx')).toBeNull()
  })
})

describe('loadCustomAgents 目录优先级', () => {
  const mk = (dir: string, file: string, content: string) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, file), content)
  }
  const agentFile = (name: string, prompt: string) => `---\nname: ${name}\ndescription: d\n---\n${prompt}`

  it('扫四目录、project>user、同级 .deepcode>.claude', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dc-home-'))
    const cwd = mkdtempSync(path.join(tmpdir(), 'dc-cwd-'))
    mk(path.join(home, '.claude', 'agents'), 'a.md', agentFile('shared', 'user-claude'))
    mk(path.join(home, '.deepcode', 'agents'), 'a.md', agentFile('shared', 'user-deepcode'))
    mk(path.join(cwd, '.claude', 'agents'), 'a.md', agentFile('shared', 'project-claude'))
    mk(path.join(cwd, '.deepcode', 'agents'), 'a.md', agentFile('shared', 'project-deepcode'))
    const list = loadCustomAgents(cwd, home)
    const merged = mergeAgents([], list).find(a => a.agentType === 'shared')!
    expect(merged.getSystemPrompt()).toBe('project-deepcode') // 最高优先级赢
  })

  it('目录不存在 → 跳过不崩', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dc-home2-'))
    const cwd = mkdtempSync(path.join(tmpdir(), 'dc-cwd2-'))
    expect(loadCustomAgents(cwd, home)).toEqual([])
  })
})

describe('mergeAgents / resolveAgents', () => {
  const agentFileFor = (name: string, prompt: string) => `---\nname: ${name}\ndescription: d\n---\n${prompt}`
  it('custom 覆盖同名 builtin、新增', () => {
    const custom = [parseAgentFile(agentFileFor('general-purpose', 'overridden'))!, parseAgentFile(agentFileFor('my-new', 'x'))!]
    const merged = mergeAgents(BUILTIN_AGENTS, custom)
    expect(merged.find(a => a.agentType === 'general-purpose')!.getSystemPrompt()).toBe('overridden')
    expect(merged.find(a => a.agentType === 'my-new')).toBeTruthy()
    expect(merged.length).toBe(BUILTIN_AGENTS.length + 1)
  })
  it('resolveAgents 空目录 → 仅 builtin', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dc-h-'))
    const cwd = mkdtempSync(path.join(tmpdir(), 'dc-c-'))
    expect(resolveAgents(cwd, home).length).toBe(BUILTIN_AGENTS.length)
  })
})
