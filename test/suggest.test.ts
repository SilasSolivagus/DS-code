// test/suggest.test.ts —— skills 补全新增用例（与 tui.suggest.test.tsx 互补）
import { describe, it, expect } from 'vitest'
import { computeSuggestions } from '../src/tui/suggest.js'

describe('computeSuggestions skills 补全', () => {
  it('/ 补全合并 skill 名（userInvocable），与 customCommand 去重，不列 userInvocable=false', () => {
    const out = computeSuggestions('/gr', {
      cwd: process.cwd(), customCommands: new Map(),
      skills: [{ name: 'greet', userInvocable: true }, { name: 'secret', userInvocable: false }],
    })
    expect(out.map(s => s.value)).toContain('/greet')
    expect(out.map(s => s.value)).not.toContain('/secret')
  })

  it('skill 候选 hint 为「技能」', () => {
    const out = computeSuggestions('/gr', {
      cwd: process.cwd(), customCommands: new Map(),
      skills: [{ name: 'greet', userInvocable: true }],
    })
    const match = out.find(s => s.value === '/greet')
    expect(match?.hint).toBe('技能')
  })

  it('skill 与 customCommand 同名时去重（skill 优先，hint 为技能）', () => {
    const out = computeSuggestions('/de', {
      cwd: process.cwd(), customCommands: new Map([['deploy', 'do deployment']]),
      skills: [{ name: 'deploy', userInvocable: true }],
    })
    const deploys = out.filter(s => s.value === '/deploy')
    expect(deploys.length).toBe(1)
    expect(deploys[0].hint).toBe('技能')
  })

  it('无 skills 时行为与原来一致（无 skills 参数）', () => {
    const out = computeSuggestions('/mo', {
      cwd: process.cwd(), customCommands: new Map(),
    })
    expect(out.map(s => s.value)).toContain('/model')
  })
})
