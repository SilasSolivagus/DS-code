// test/tui.suggest.test.tsx
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { computeSuggestions, BUILTIN_COMMANDS } from '../src/tui/suggest.js'
import { Suggestions } from '../src/tui/components/Suggestions.js'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

describe('computeSuggestions', () => {
  it('"/" 列出全部内置命令，"/mo" 前缀过滤，自定义命令并入', () => {
    const all = computeSuggestions('/', { cwd: '/tmp', customCommands: new Map([['review', 'x']]) })
    expect(all.map(s => s.value)).toContain('/model')
    expect(all.map(s => s.value)).toContain('/review')
    expect(all.length).toBe(BUILTIN_COMMANDS.length + 1)
    const filtered = computeSuggestions('/mo', { cwd: '/tmp', customCommands: new Map() })
    expect(filtered.map(s => s.value)).toEqual(['/model'])
  })

  it('"@" 后缀按文件名模糊匹配 cwd 下文件', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sg-'))
    mkdirSync(path.join(dir, 'src'))
    writeFileSync(path.join(dir, 'src', 'main.ts'), '')
    writeFileSync(path.join(dir, 'readme.md'), '')
    const s = computeSuggestions('看一下 @ma', { cwd: dir, customCommands: new Map() })
    expect(s.some(x => x.value.endsWith('src/main.ts'))).toBe(true)
    expect(s.some(x => x.value.endsWith('readme.md'))).toBe(false)
  })

  it('非 / 非 @ 输入不出菜单', () => {
    expect(computeSuggestions('普通话', { cwd: '/tmp', customCommands: new Map() })).toEqual([])
  })

  // P4 死锁修复：键入完整命令全名后，菜单必须让位，否则补全菜单永久接管回车导致命令无法提交
  it('精确等于某命令全名时返回空菜单（让回车直接提交，对齐 CC）', () => {
    expect(computeSuggestions('/exit', { cwd: '/tmp', customCommands: new Map() })).toEqual([])
    expect(computeSuggestions('/think', { cwd: '/tmp', customCommands: new Map() })).toEqual([])
  })

  it('精确全名隐藏仅对精确匹配生效，部分前缀仍出菜单', () => {
    expect(computeSuggestions('/ex', { cwd: '/tmp', customCommands: new Map() }).map(s => s.value)).toContain('/exit')
    // /co 是 /cost /context /compact /clear 的共同前缀但不精确等于任何一个，菜单照出
    const co = computeSuggestions('/co', { cwd: '/tmp', customCommands: new Map() }).map(s => s.value)
    expect(co).toEqual(expect.arrayContaining(['/cost', '/context', '/compact']))
    expect(co.length).toBeGreaterThan(1)
  })

  it('自定义命令精确全名同样隐藏菜单', () => {
    const env = { cwd: '/tmp', customCommands: new Map([['deploy', 'x']]) }
    expect(computeSuggestions('/deploy', env)).toEqual([])
    expect(computeSuggestions('/dep', env).map(s => s.value)).toContain('/deploy')
  })
})

describe('Suggestions 组件', () => {
  it('渲染候选列表并高亮选中项，Tab/Enter 回调补全值', async () => {
    const onPick = vi.fn()
    const items = [{ value: '/model', hint: 'flash↔pro' }, { value: '/think', hint: 'thinking 开关' }]
    const r = render(<Suggestions items={items} onPick={onPick} />)
    await new Promise(res => setTimeout(res, 0))
    expect(r.lastFrame()).toContain('/model')
    r.stdin.write('\x1b[B')   // ↓ 选中第二项
    await new Promise(res => setTimeout(res, 0))
    r.stdin.write('\t')       // Tab 补全
    await new Promise(res => setTimeout(res, 0))
    expect(onPick).toHaveBeenCalledWith('/think')
  })
})
