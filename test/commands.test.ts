// test/commands.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadCustomCommands, expandCommand, formatContext } from '../src/commands.js'

let home: string, proj: string
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'dc-home-'))
  proj = mkdtempSync(path.join(tmpdir(), 'dc-proj-'))
})

describe('loadCustomCommands', () => {
  it('加载全局与项目命令，项目同名覆盖全局', () => {
    mkdirSync(path.join(home, '.deepcode', 'commands'), { recursive: true })
    mkdirSync(path.join(proj, '.deepcode', 'commands'), { recursive: true })
    writeFileSync(path.join(home, '.deepcode', 'commands', 'review.md'), '全局审查 $ARGUMENTS')
    writeFileSync(path.join(home, '.deepcode', 'commands', 'deploy.md'), '部署')
    writeFileSync(path.join(proj, '.deepcode', 'commands', 'review.md'), '项目审查 $ARGUMENTS')
    const cmds = loadCustomCommands(proj, home)
    expect(cmds.get('review')).toBe('项目审查 $ARGUMENTS')
    expect(cmds.get('deploy')).toBe('部署')
  })

  it('目录不存在时返回空表不报错', () => {
    expect(loadCustomCommands(proj, home).size).toBe(0)
  })
})

describe('expandCommand', () => {
  it('替换全部 $ARGUMENTS', () => {
    expect(expandCommand('检查 $ARGUMENTS，再测 $ARGUMENTS', 'src/a.ts')).toBe('检查 src/a.ts，再测 src/a.ts')
  })
})

describe('formatContext', () => {
  it('输出各部分占比与上次 usage', () => {
    const messages = [
      { role: 'system', content: 'x'.repeat(400) },
      { role: 'user', content: 'y'.repeat(300) },
      { role: 'tool', tool_call_id: 't', content: 'z'.repeat(300) },
    ]
    const out = formatContext(messages, { prompt_tokens: 1234, prompt_cache_hit_tokens: 1000 })
    expect(out).toContain('40%')
    expect(out).toContain('1234')
    expect(out).toContain('1000')
  })

  it('无 usage 时不崩', () => {
    expect(formatContext([{ role: 'user', content: 'hi' }])).toContain('尚无')
  })
})
