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
  it('簇 1↔簇 2、簇 2↔簇 3 之间各有空行', () => {
    const { lastFrame } = render(<StatusFooter {...base} />)
    const f = lastFrame()!
    expect(blanksBetween(f, 'deepseek', 'Context')).toBeGreaterThanOrEqual(1) // 簇1↔簇2
    expect(blanksBetween(f, 'Context', 'DEEPCODE.md')).toBeGreaterThanOrEqual(1) // 簇2↔簇3
  })

  it('无记忆/无工具时簇 3 不留空簇（簇2↔命令提示仍恰一空行）', () => {
    const { lastFrame } = render(<StatusFooter {...base} memoryCount={0} toolCounts={[]} />)
    const f = lastFrame()!
    expect(blanksBetween(f, 'Context', '看命令')).toBe(1)
  })
})
