import { describe, it, expect } from 'vitest'
import { parseFrontmatter, parseToolList, resolveAgentModelAlias } from '../src/agentsLoader.js'

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
