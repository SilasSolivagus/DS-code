import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../src/prompt.js'
import type { OutputStyle } from '../src/outputStyles.js'

const explan: OutputStyle = { name: 'Explanatory', description: '', keepCodingInstructions: true, prompt: 'ZZZ_解说标记' }
const replace: OutputStyle = { name: 'X', description: '', keepCodingInstructions: false, prompt: 'YYY_替换标记' }

describe('buildSystemPrompt 段结构 + 输出风格门控', () => {
  it('默认：含全部 5 段', () => {
    const p = buildSystemPrompt(process.cwd(), undefined, [], undefined, undefined, undefined)
    expect(p).toContain('# 系统')
    expect(p).toContain('# 干活')
    expect(p).toContain('# 谨慎执行破坏性动作')
    expect(p).toContain('# 用好工具')
    expect(p).toContain('# 语气与风格')
  })

  it('keepCodingInstructions=true：# 干活 仍在 + 末尾追加风格段', () => {
    const p = buildSystemPrompt(process.cwd(), undefined, [], undefined, undefined, explan)
    expect(p).toContain('# 干活')
    expect(p).toContain('ZZZ_解说标记')
    expect(p.indexOf('ZZZ_解说标记')).toBeGreaterThan(p.indexOf('# 语气与风格'))
  })

  it('keepCodingInstructions=false：省略 # 干活，但安全/工具/语气段恒在', () => {
    const p = buildSystemPrompt(process.cwd(), undefined, [], undefined, undefined, replace)
    expect(p).toContain('YYY_替换标记')
    expect(p).not.toContain('# 干活')
    // 关键守卫：output-style 绝不删除这些段
    expect(p).toContain('# 系统')
    expect(p).toContain('# 谨慎执行破坏性动作')
    expect(p).toContain('# 用好工具')
    expect(p).toContain('# 语气与风格')
  })
})
