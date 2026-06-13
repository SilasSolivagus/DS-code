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
})
