import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../src/prompt.js'
import type { OutputStyle } from '../src/outputStyles.js'

const explan: OutputStyle = { name: 'Explanatory', description: '', keepCodingInstructions: true, prompt: 'ZZZ_解说标记' }
const replace: OutputStyle = { name: 'X', description: '', keepCodingInstructions: false, prompt: 'YYY_替换标记' }

describe('buildSystemPrompt 输出风格注入', () => {
  it('无 outputStyle：含工作守则块、不含风格标记', () => {
    const p = buildSystemPrompt(process.cwd(), undefined, [], undefined, undefined, undefined)
    expect(p).toContain('# 工作守则')
    expect(p).not.toContain('ZZZ_解说标记')
  })

  it('keepCodingInstructions=true：工作守则块仍在 + 追加风格段', () => {
    const p = buildSystemPrompt(process.cwd(), undefined, [], undefined, undefined, explan)
    expect(p).toContain('# 工作守则')
    expect(p).toContain('ZZZ_解说标记')
    // 风格段在工作守则之后
    expect(p.indexOf('ZZZ_解说标记')).toBeGreaterThan(p.indexOf('# 工作守则'))
  })

  it('keepCodingInstructions=false：替换工作守则块（不再含原守则首条）', () => {
    const p = buildSystemPrompt(process.cwd(), undefined, [], undefined, undefined, replace)
    expect(p).toContain('YYY_替换标记')
    expect(p).not.toContain('回答关于代码的问题前，先用 Glob/Grep/Read 查证')
  })
})
