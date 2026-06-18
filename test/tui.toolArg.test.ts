// test/tui.toolArg.test.ts
import { describe, it, expect } from 'vitest'
import { formatToolArg } from '../src/tui/toolArg.js'

describe('formatToolArg', () => {
  it('Read/Edit/Write → file_path', () => {
    const desc = JSON.stringify({ file_path: 'src/foo.ts', offset: 1 })
    expect(formatToolArg('Read', desc)).toBe('src/foo.ts')
    expect(formatToolArg('Edit', desc)).toBe('src/foo.ts')
    expect(formatToolArg('Write', desc)).toBe('src/foo.ts')
  })

  it('Bash → command', () => {
    expect(formatToolArg('Bash', JSON.stringify({ command: 'ls -la' }))).toBe('ls -la')
  })

  it('Grep/Glob → pattern', () => {
    expect(formatToolArg('Grep', JSON.stringify({ pattern: 'foo.*bar' }))).toBe('foo.*bar')
    expect(formatToolArg('Glob', JSON.stringify({ pattern: '**/*.ts' }))).toBe('**/*.ts')
  })

  it('Agent → description', () => {
    expect(formatToolArg('Agent', JSON.stringify({ description: '搜索代码' }))).toBe('搜索代码')
  })

  it('TaskCreate 显示 subject', () => {
    expect(formatToolArg('TaskCreate', JSON.stringify({ subject: '修登录 bug', description: 'd' }))).toBe('修登录 bug')
  })
  it('TaskUpdate 显示 #id → status', () => {
    expect(formatToolArg('TaskUpdate', JSON.stringify({ taskId: '3', status: 'completed' }))).toBe('#3 → completed')
  })

  it('未知工具 → 第一个字符串字段', () => {
    expect(formatToolArg('Mystery', JSON.stringify({ count: 3, label: '你好', flag: true }))).toBe('你好')
  })

  it('未知工具且无字符串字段 → 空串', () => {
    expect(formatToolArg('Mystery', JSON.stringify({ count: 3, flag: true }))).toBe('')
  })

  it('JSON 解析失败 → 原文截断', () => {
    expect(formatToolArg('Read', 'not json')).toBe('not json')
  })

  it('截断到 60 字符并加 …', () => {
    const long = 'a'.repeat(100)
    const out = formatToolArg('Bash', JSON.stringify({ command: long }))
    expect(out).toBe('a'.repeat(60) + '…')
    expect(out.length).toBe(61)
  })

  it('多行命令折叠为单行', () => {
    const out = formatToolArg('Bash', JSON.stringify({ command: 'echo a\necho b\techo c' }))
    expect(out).toBe('echo a echo b echo c')
    expect(out).not.toContain('\n')
  })
})
