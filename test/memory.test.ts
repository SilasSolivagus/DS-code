import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { formatMemory } from '../src/memory.js'

const HOME = '/home/u'
const GLOBAL = path.join(HOME, '.deepcode', 'DEEPCODE.md')

describe('formatMemory', () => {
  it('空列表：提示没有生效的记忆文件 + 如何创建', () => {
    const out = formatMemory([], HOME)
    expect(out).toContain('当前没有生效的记忆文件')
    expect(out).toContain('/init')
    expect(out).toContain(GLOBAL)
  })

  it('单文件：列出该路径', () => {
    const f = '/work/proj/DEEPCODE.md'
    const out = formatMemory([f], HOME)
    expect(out).toContain(f)
    expect(out).not.toContain('当前没有生效的记忆文件')
  })

  it('多文件：项目 + 全局都列出', () => {
    const proj = '/work/proj/DEEPCODE.md'
    const out = formatMemory([proj, GLOBAL], HOME)
    expect(out).toContain(proj)
    expect(out).toContain(GLOBAL)
  })

  it('全局不在列表时：提示全局文件不存在、可创建', () => {
    const proj = '/work/proj/DEEPCODE.md'
    const out = formatMemory([proj], HOME)
    expect(out).toContain(GLOBAL)
    expect(out).toMatch(/不存在|可创建/)
  })

  it('全局已在列表时：不重复提示其不存在', () => {
    const out = formatMemory([GLOBAL], HOME)
    // 全局已生效，不应出现"不存在"这类提示
    expect(out).not.toMatch(/全局.*不存在/)
  })

  it('始终包含 /init 编辑提示', () => {
    expect(formatMemory(['/a/DEEPCODE.md'], HOME)).toContain('/init')
  })
})
