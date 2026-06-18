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
  hitRate: 0,
  cacheSavings: 0,
  toolCounts: [{ name: 'Read', n: 4 }, { name: 'Bash', n: 2 }],
}

describe('StatusFooter', () => {
  it('CC 格式：[模型 | 模式] | cwd git:(分支) / Context 条 / N DEEPCODE.md / ✓ 工具 ×n / 快捷键', () => {
    const f = render(<StatusFooter {...base} />).lastFrame()!
    expect(f).toContain('deepseek-v4-flash')
    expect(f).toContain('| default]')      // 方括号 + | 分隔的模式
    expect(f).toContain('deepcode')
    expect(f).toContain('git:(main)')
    expect(f).toContain('Context')
    expect(f).toContain('28%')
    expect(f).toContain('$0.0042')
    expect(f).toContain('2 DEEPCODE.md')
    expect(f).toContain('Read ×4')         // × 前留空（CC 样式）
    expect(f).toContain('Bash ×2')
    expect(f).toContain('看命令')
    // 上下文条同时有 filled 与 empty 字符
    expect(f).toContain('▓')
    expect(f).toContain('░')
  })

  it('无 git 分支时省略 git:() 段', () => {
    const f = render(<StatusFooter {...base} branch={null} />).lastFrame()!
    expect(f).not.toContain('git:(')
  })

  it('memoryCount===0 时省略 DEEPCODE.md 段', () => {
    const f = render(<StatusFooter {...base} memoryCount={0} />).lastFrame()!
    expect(f).not.toContain('DEEPCODE.md')
    expect(f).toContain('Read ×4')
  })

  it('无工具调用且无记忆时只剩 模型行/上下文行/快捷键（无工具✓、无 DEEPCODE.md）', () => {
    const f = render(<StatusFooter {...base} memoryCount={0} toolCounts={[]} />).lastFrame()!
    expect(f).not.toContain('✓')
    expect(f).not.toContain('DEEPCODE.md')
    expect(f).toContain('Context')
    expect(f).toContain('看命令')
  })

  it('hitRate>0 时 Row 2 显示 cache N% 与省下金额', () => {
    const f = render(<StatusFooter {...base} hitRate={0.87} cacheSavings={0.0089} />).lastFrame()!
    expect(f).toContain('cache 87%')
    expect(f).toContain('−$0.0089')
  })

  it('hitRate===0 时隐藏整个 cache 段（仍显示 Context 与花费）', () => {
    const f = render(<StatusFooter {...base} hitRate={0} cacheSavings={0} />).lastFrame()!
    expect(f).not.toContain('cache')
    expect(f).toContain('Context')
    expect(f).toContain('$0.0042')
  })
})
