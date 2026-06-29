import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { StatusFooter } from '../src/tui/components/StatusFooter.js'

const base = {
  model: 'deepseek', mode: 'default', cwdBase: 'proj', branch: 'main',
  memoryCount: 2, contextUsed: 1000, contextWindow: 100000, cost: 0.12,
  hitRate: 0, cacheSavings: 0, thinking: false, effortLevel: 'medium' as const,
  toolCounts: [{ name: 'Bash', n: 2 }], statusLineOutput: null,
}

function blanksBetween(frame: string, a: string, b: string): number {
  const lines = frame.split('\n')
  const ia = lines.findIndex(l => l.includes(a))
  const ib = lines.findIndex(l => l.includes(b))
  return lines.slice(ia + 1, ib).filter(l => l.trim() === '').length
}

describe('StatusFooter 分组', () => {
  it('页脚 3 簇紧邻、簇间无空行（用户要求不隔行）', () => {
    const { lastFrame } = render(<StatusFooter {...base} />)
    const f = lastFrame()!
    expect(blanksBetween(f, 'deepseek', 'Context')).toBe(0) // 簇1↔簇2 紧邻
    expect(blanksBetween(f, 'Context', 'DEEPCODE.md')).toBe(0) // 簇2↔簇3 紧邻
  })

  it('无记忆/无工具时簇 3 紧接簇 2（无空行）', () => {
    const { lastFrame } = render(<StatusFooter {...base} memoryCount={0} toolCounts={[]} />)
    const f = lastFrame()!
    expect(blanksBetween(f, 'Context', '看命令')).toBe(0)
  })
})
