// test/tui.permission.test.tsx
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { buildPreview } from '../src/tui/diffPreview.js'
import { PermissionDialog } from '../src/tui/components/PermissionDialog.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

describe('buildPreview', () => {
  it('Edit：对现有文件产出 ±行 diff', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dp-'))
    const f = path.join(dir, 'a.ts')
    writeFileSync(f, 'const a = 1\nconst b = 2\n')
    const p = buildPreview('Edit', JSON.stringify({ file_path: f, old_string: 'const b = 2', new_string: 'const b = 3' }))
    expect(p.lines.some(l => l.sign === '-' && l.text.includes('const b = 2'))).toBe(true)
    expect(p.lines.some(l => l.sign === '+' && l.text.includes('const b = 3'))).toBe(true)
  })

  it('Write 新文件：全部 + 行；Write 覆盖：与现有内容 diff', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dp-'))
    const p1 = buildPreview('Write', JSON.stringify({ file_path: path.join(dir, 'new.ts'), content: 'line1\nline2' }))
    expect(p1.lines.every(l => l.sign === '+')).toBe(true)
    const f = path.join(dir, 'old.ts')
    writeFileSync(f, 'keep\ndrop\n')
    const p2 = buildPreview('Write', JSON.stringify({ file_path: f, content: 'keep\nnew\n' }))
    expect(p2.lines.some(l => l.sign === '-' && l.text === 'drop')).toBe(true)
    expect(p2.lines.some(l => l.sign === '+' && l.text === 'new')).toBe(true)
  })

  it('Bash/非法参数：降级为 desc 原文展示，不抛异常', () => {
    const p = buildPreview('Bash', '{"command":"rm -rf /tmp/x"}')
    expect(p.lines.length).toBeGreaterThan(0)
    expect(buildPreview('Edit', '不是json').lines.length).toBeGreaterThan(0)
  })

  it('Bash 命令含 ESC/CR：输出行中不含控制字符', () => {
    // 注入向量：\x1b[31m 可改变终端颜色；\r 可覆盖已渲染的行首内容，
    // 令用户看到的批准命令与实际执行命令不一致。
    const malicious = 'ls\x1b[31m\r'
    const p = buildPreview('Bash', JSON.stringify({ command: malicious }))
    for (const line of p.lines) {
      expect(line.text).not.toMatch(/\x1b/)
      expect(line.text).not.toMatch(/\r/)
    }
  })

  it('Edit new_string 含 $& 字面量：+ 行原样显示 pre-$&-post', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dp-'))
    const f = path.join(dir, 'b.ts')
    writeFileSync(f, 'hello world\n')
    const p = buildPreview('Edit', JSON.stringify({ file_path: f, old_string: 'hello world', new_string: 'pre-$&-post' }))
    expect(p.lines.some(l => l.sign === '+' && l.text.includes('pre-$&-post'))).toBe(true)
  })

  it('Edit old_string 不在文件中：产出含"无差异"提示行', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dp-'))
    const f = path.join(dir, 'c.ts')
    writeFileSync(f, 'const x = 1\n')
    const p = buildPreview('Edit', JSON.stringify({ file_path: f, old_string: 'not_found', new_string: 'whatever' }))
    expect(p.lines.length).toBeGreaterThan(0)
    expect(p.lines.some(l => l.text.includes('无差异'))).toBe(true)
  })
})

const delay = (ms = 0) => new Promise(res => setTimeout(res, ms))

describe('PermissionDialog', () => {
  const base = { toolName: 'Edit', desc: '{"file_path":"/tmp/x","old_string":"a","new_string":"b"}', dangerous: false }
  it('y/n/a 按键回调对应决策', async () => {
    const onDecide = vi.fn()
    const r = render(<PermissionDialog ask={{ ...base, resolve: onDecide }} onDecide={onDecide} />)
    await delay()
    r.stdin.write('a')
    expect(onDecide).toHaveBeenCalledWith('always')
  })
  it('高危显示红色警告', () => {
    const r = render(<PermissionDialog ask={{ ...base, toolName: 'Bash', desc: '{"command":"sudo rm -rf /"}', dangerous: true, resolve: () => {} }} onDecide={() => {}} />)
    expect(r.lastFrame()).toContain('高危')
  })
  it('大写 A 也触发 always 决策（大小写不敏感）', async () => {
    const onDecide = vi.fn()
    const r = render(<PermissionDialog ask={{ ...base, resolve: onDecide }} onDecide={onDecide} />)
    await delay()
    r.stdin.write('A')
    expect(onDecide).toHaveBeenCalledWith('always')
  })
  it('初始选中"允许"：渲染含 ❯ 允许，直接 Enter = yes', async () => {
    const onDecide = vi.fn()
    const r = render(<PermissionDialog ask={{ ...base, resolve: onDecide }} onDecide={onDecide} />)
    await delay()
    expect(r.lastFrame()).toContain('❯ 允许')
    r.stdin.write('\r')
    expect(onDecide).toHaveBeenCalledWith('yes')
  })
  it('↓ + Enter = always', async () => {
    const onDecide = vi.fn()
    const r = render(<PermissionDialog ask={{ ...base, resolve: onDecide }} onDecide={onDecide} />)
    await delay()
    r.stdin.write('\x1b[B')
    await delay()
    r.stdin.write('\r')
    expect(onDecide).toHaveBeenCalledWith('always')
  })
  it('↓↓ + Enter = no（到底后再 ↓ 不越界）', async () => {
    const onDecide = vi.fn()
    const r = render(<PermissionDialog ask={{ ...base, resolve: onDecide }} onDecide={onDecide} />)
    await delay()
    r.stdin.write('\x1b[B')
    await delay()
    r.stdin.write('\x1b[B')
    await delay()
    r.stdin.write('\x1b[B')
    await delay()
    r.stdin.write('\r')
    expect(onDecide).toHaveBeenCalledWith('no')
  })
  it('Esc = no', async () => {
    const onDecide = vi.fn()
    const r = render(<PermissionDialog ask={{ ...base, resolve: onDecide }} onDecide={onDecide} />)
    await delay()
    r.stdin.write('\x1b')
    expect(onDecide).toHaveBeenCalledWith('no')
  })
})
