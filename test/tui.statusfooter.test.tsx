// test/tui.statusfooter.test.tsx
import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { StatusFooter, contextBarColor, contextBar } from '../src/tui/components/StatusFooter.js'
import { T } from '../src/tui/theme.js'

const base = {
  model: 'deepseek-v4-flash',
  mode: 'default',
  cwdBase: 'deepcode',
  branch: 'main' as string | null,
  memoryCount: 2,
  contextUsed: 28000,
  contextWindow: 100000,
  cost: 0.0042,
  hitRate: 0,
  cacheSavings: 0,
  thinking: false,
  effortLevel: 'medium' as 'low' | 'medium' | 'high',
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
    expect(f).toContain('28k / 100k')
    expect(f).toContain('¥0.0042')
    expect(f).toContain('2 DEEPCODE.md')
    expect(f).toContain('Read ×4')         // × 前留空（CC 样式）
    expect(f).toContain('Bash ×2')
    expect(f).toContain('看命令')
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
    expect(f).toContain('−¥0.0089')
  })

  it('hitRate===0 时隐藏整个 cache 段（仍显示 Context 与花费）', () => {
    const f = render(<StatusFooter {...base} hitRate={0} cacheSavings={0} />).lastFrame()!
    expect(f).not.toContain('cache')
    expect(f).toContain('Context')
    expect(f).toContain('¥0.0042')
  })

  it('thinking 开时 Row 1 显示 think:档位', () => {
    const f = render(<StatusFooter {...base} thinking={true} effortLevel="high" />).lastFrame()!
    expect(f).toContain('think:high')
  })
  it('thinking 关时不显示 think 段', () => {
    const f = render(<StatusFooter {...base} thinking={false} />).lastFrame()!
    expect(f).not.toContain('think:')
  })

  it('tokenBudget 有值时 Row 2 显示 budget 已用/目标', () => {
    const f = render(<StatusFooter {...base} tokenBudget={500_000} budgetUsed={320_000} />).lastFrame()!
    expect(f).toContain('budget 320k/500k')
  })
  it('tokenBudget 未设时不显示 budget 段', () => {
    const f = render(<StatusFooter {...base} tokenBudget={null} />).lastFrame()!
    expect(f).not.toContain('budget')
  })

  it('上下文段显绝对值 used / window', () => {
    const f = render(<StatusFooter {...base} contextUsed={132_000} contextWindow={971_000} />).lastFrame()!
    expect(f).toContain('132k / 971k')
  })

  it('used/window ≥95% 时红色（比值变色）', () => {
    // used=960000 window=971000 → 98.9% → 红 → contextBarColor returns T.err
    // 小值也走同一分支：验证 contextBarColor 函数本身
    expect(contextBarColor(960_000 / 971_000 * 100)).toBe(T.err)
  })

  it('contextBarColor 分档：<80 accent, 80-94 warn, >=95 err', () => {
    expect(contextBarColor(50)).toBe(T.accent)
    expect(contextBarColor(85)).toBe(T.warn)
    expect(contextBarColor(96)).toBe(T.err)
  })

  it('contextBar：满格/空格/非零至少一格/越界钳制', () => {
    expect(contextBar(0)).toBe('░'.repeat(10))
    expect(contextBar(100)).toBe('█'.repeat(10))
    expect(contextBar(50)).toBe('█'.repeat(5) + '░'.repeat(5))
    expect(contextBar(4)).toBe('█' + '░'.repeat(9))   // 非零但 <半格 → 至少 1 格
    expect(contextBar(150)).toBe('█'.repeat(10))       // 越界上钳
    expect(contextBar(-5)).toBe('░'.repeat(10))        // 越界下钳
  })

  it('Row 2 渲染迷你进度条', () => {
    const f = render(<StatusFooter {...base} contextUsed={100_000} contextWindow={200_000} />).lastFrame()!
    expect(f).toContain('[' + '█'.repeat(5) + '░'.repeat(5) + ']')
  })
})
