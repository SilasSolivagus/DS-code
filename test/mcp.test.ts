import { describe, it, expect } from 'vitest'
import { normalizeNameForMCP, buildMcpToolName } from '../src/mcp.js'

describe('normalizeNameForMCP', () => {
  it('保留合法字符，非法字符替换为下划线', () => {
    expect(normalizeNameForMCP('git_diff-tool')).toBe('git_diff-tool')
    expect(normalizeNameForMCP('my server.v2')).toBe('my_server_v2')
    expect(normalizeNameForMCP('a/b:c')).toBe('a_b_c')
  })
})

describe('buildMcpToolName', () => {
  it('拼成 mcp__<server>__<tool> 并各自归一化', () => {
    expect(buildMcpToolName('github', 'create_issue')).toBe('mcp__github__create_issue')
    expect(buildMcpToolName('my server', 'do.it')).toBe('mcp__my_server__do_it')
  })
})
