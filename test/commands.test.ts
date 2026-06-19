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

  it('args 含 $$ 和 $& 时原样保留（不被 replacement pattern 解释）', () => {
    expect(expandCommand('run $ARGUMENTS', 'echo $$ and $&')).toBe('run echo $$ and $&')
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

  it('中文消息 token 估算显著高于旧 chars/4', () => {
    // 样例：'这是一段纯中文内容用来测试token估算'.repeat(5)
    // = 15 CJK×0.6 + 5 ASCII×0.3 = 10.5 weight/repeat × 5 = 52.5 → ceil = 53 tokens
    // 旧 chars/4：round(100/4) = 25；新 ≈ 53，约 2.1×
    const msgs = [{ role: 'user', content: '这是一段纯中文内容用来测试token估算'.repeat(5) }]
    const out = formatContext(msgs)
    // 找「对话文本」行，提取 token 数
    const convoRow = out.split('\n').find(r => r.startsWith('对话文本'))!
    expect(convoRow).toBeDefined()
    const m = convoRow.match(/≈(\d+) tokens/)
    expect(m).not.toBeNull()
    const tokens = Number(m![1])
    expect(tokens).toBe(53)          // ceil(52.5) via estimateTextTokens
    expect(tokens).toBeGreaterThan(30) // 显著高于旧值 25
  })

  it('content 为 null 的 assistant tool_calls 不崩，且计入工具调用与结果', () => {
    const messages = [
      { role: 'system', content: 'x'.repeat(400) },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c', type: 'function', function: { name: 'Read', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c', content: 'result' },
    ]
    const out = formatContext(messages)
    const rows = out.split('\n')
    expect(rows).toHaveLength(4) // 3 占比行 + usage 行
    expect(out).toContain('工具调用与结果')
    // 工具桶非零：tool_calls JSON 长度 > 0，结果内容 > 0
    const toolRow = rows.find(r => r.startsWith('工具调用与结果'))!
    expect(toolRow).not.toContain('0%')
  })
})
