import { describe, it, expect } from 'vitest'
import { normalizeNameForMCP, buildMcpToolName } from '../src/mcp.js'
import { expandEnvVars } from '../src/mcp.js'

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

describe('expandEnvVars', () => {
  const env = { FOO: 'bar', EMPTY: '' }
  it('${VAR} 展开为值，未设则空串', () => {
    expect(expandEnvVars('x=${FOO}', env)).toBe('x=bar')
    expect(expandEnvVars('x=${MISSING}', env)).toBe('x=')
  })
  it('${VAR:-default} 在未设或空时用默认', () => {
    expect(expandEnvVars('${MISSING:-fallback}', env)).toBe('fallback')
    expect(expandEnvVars('${EMPTY:-fallback}', env)).toBe('fallback')
    expect(expandEnvVars('${FOO:-fallback}', env)).toBe('bar')
  })
  it('多处展开与无占位原样', () => {
    expect(expandEnvVars('${FOO}/${FOO}', env)).toBe('bar/bar')
    expect(expandEnvVars('plain text', env)).toBe('plain text')
  })
})
