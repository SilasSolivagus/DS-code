import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findMemoryFiles, buildSystemPrompt } from '../src/prompt.js'
import type { SkillDefinition } from '../src/skillsLoader.js'

describe('findMemoryFiles', () => {
  it('从 cwd 向上收集 CLAUDE.md/AGENTS.md，再加全局 DEEPCODE.md', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dc-'))
    mkdirSync(path.join(root, 'a/b'), { recursive: true })
    writeFileSync(path.join(root, 'CLAUDE.md'), 'root memory')
    writeFileSync(path.join(root, 'a/b/AGENTS.md'), 'leaf memory')
    const home = mkdtempSync(path.join(tmpdir(), 'dc-home-'))
    mkdirSync(path.join(home, '.deepcode'))
    writeFileSync(path.join(home, '.deepcode/DEEPCODE.md'), 'global memory')

    const files = findMemoryFiles(path.join(root, 'a/b'), home)
    expect(files[0].endsWith('AGENTS.md')).toBe(true)
    expect(files.some(f => f.endsWith('CLAUDE.md'))).toBe(true)
    expect(files.at(-1)!.endsWith('DEEPCODE.md')).toBe(true)
  })

  it('同目录 CLAUDE.md 优先于 AGENTS.md，只取一个', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dc-'))
    writeFileSync(path.join(root, 'CLAUDE.md'), 'c')
    writeFileSync(path.join(root, 'AGENTS.md'), 'a')
    const files = findMemoryFiles(root, mkdtempSync(path.join(tmpdir(), 'dc-home-')))
    expect(files.filter(f => f.startsWith(root)).length).toBe(1)
    expect(files[0].endsWith('CLAUDE.md')).toBe(true)
  })

  it('同目录 DEEPCODE.md 优先于 CLAUDE.md（deepcode 原生记忆文件最高优先）', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dc-'))
    writeFileSync(path.join(root, 'DEEPCODE.md'), 'd')
    writeFileSync(path.join(root, 'CLAUDE.md'), 'c')
    const files = findMemoryFiles(root, mkdtempSync(path.join(tmpdir(), 'dc-home-')))
    expect(files.filter(f => f.startsWith(root)).length).toBe(1)
    expect(files[0].endsWith('DEEPCODE.md')).toBe(true)
  })
})

describe('buildSystemPrompt', () => {
  it('包含身份、守则、环境与项目记忆', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dc-'))
    writeFileSync(path.join(root, 'CLAUDE.md'), '用中文回复测试标记XYZ')
    const p = buildSystemPrompt(root, mkdtempSync(path.join(tmpdir(), 'dc-home-')))
    expect(p).toContain('deepcode')
    expect(p).toContain('必须先用 Read')
    expect(p).toContain(root)
    expect(p).toContain('测试标记XYZ')
  })

  it('守则包含歧义先确认与 Bash 无 tty 两条规则', () => {
    const p = buildSystemPrompt(mkdtempSync(path.join(tmpdir(), 'dc-')), mkdtempSync(path.join(tmpdir(), 'dc-home-')))
    expect(p).toContain('歧义')
    expect(p).toContain('tty')
    expect(p).toContain('用户自己运行')
  })

  it('守则包含 P5 终点线交付三条：先验证能用 / 选可打开的介质 / 如实汇报', () => {
    const p = buildSystemPrompt(mkdtempSync(path.join(tmpdir(), 'dc-')), mkdtempSync(path.join(tmpdir(), 'dc-home-')))
    expect(p).toContain('终点线')      // 报告完成前先实际验证
    expect(p).toContain('HTML')        // 优先选可打开/可运行的介质
    expect(p).toContain('xdg-open')
    expect(p).toContain('如实汇报')    // 诚实性条款
  })

  it('清单注入：只列 modelInvocable 的 skill；空/无 skills 不加节', () => {
    const cwd = process.cwd()
    expect(buildSystemPrompt(cwd, undefined, [])).not.toContain('可用技能')
    const skills: SkillDefinition[] = [
      { name: 'a', description: '甲', context: 'inline', userInvocable: true, modelInvocable: true, skillDir: '/d', isLegacy: false, body: 'x' },
      { name: 'b', description: '乙', context: 'inline', userInvocable: true, modelInvocable: false, skillDir: '/d', isLegacy: true, body: 'y' },
    ]
    const p = buildSystemPrompt(cwd, undefined, skills)
    expect(p).toContain('可用技能')
    expect(p).toContain('a：甲')
    expect(p).not.toContain('乙') // b 不可由模型调用，不列
  })
})
