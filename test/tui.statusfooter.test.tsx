// test/tui.statusfooter.test.tsx
import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { StatusFooter } from '../src/tui/components/StatusFooter.js'

const base = {
  model: 'deepseek-v4-flash',
  mode: 'default',
  cwdBase: 'deepcode',
  branch: 'main' as string | null,
  memoryCount: 2,
  contextPct: 28,
  cost: 0.0042,
  toolCounts: [{ name: 'Read', n: 4 }, { name: 'Bash', n: 2 }],
}

describe('StatusFooter', () => {
  it('渲染模型、模式、git、上下文条、记忆与工具计数、快捷键提示', () => {
    const f = render(<StatusFooter {...base} />).lastFrame()!
    expect(f).toContain('deepseek-v4-flash')
    expect(f).toContain('default')
    expect(f).toContain('deepcode')
    expect(f).toContain('git:(main)')
    expect(f).toContain('Context')
    expect(f).toContain('28%')
    expect(f).toContain('$0.0042')
    expect(f).toContain('2 CLAUDE.md')
    expect(f).toContain('Read×4')
    expect(f).toContain('Bash×2')
    expect(f).toContain('? 查看快捷键')
    // 上下文条同时有 filled 与 empty 字符
    expect(f).toContain('▓')
    expect(f).toContain('░')
  })

  it('无 git 分支时省略 git:() 段', () => {
    const f = render(<StatusFooter {...base} branch={null} />).lastFrame()!
    expect(f).not.toContain('git:(')
  })

  it('memoryCount===0 时省略 CLAUDE.md 段', () => {
    const f = render(<StatusFooter {...base} memoryCount={0} />).lastFrame()!
    expect(f).not.toContain('CLAUDE.md')
    expect(f).toContain('Read×4')
  })

  it('无工具调用且无记忆时显示占位文案', () => {
    const f = render(<StatusFooter {...base} memoryCount={0} toolCounts={[]} />).lastFrame()!
    expect(f).toContain('（暂无工具调用）')
  })
})
