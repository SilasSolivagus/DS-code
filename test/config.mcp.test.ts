import { describe, it, expect } from 'vitest'
import { parseMcpServers } from '../src/config.js'

describe('parseMcpServers', () => {
  it('保留含 string command 的条目，归一字段', () => {
    const out = parseMcpServers({
      git: { command: 'uvx', args: ['mcp-server-git'], env: { TOKEN: 'x' } },
    })
    expect(out).toEqual({ git: { command: 'uvx', args: ['mcp-server-git'], env: { TOKEN: 'x' } } })
  })
  it('丢弃无 command / 非对象 / 非法 args 的条目', () => {
    const out = parseMcpServers({
      bad1: { args: ['x'] },
      bad2: 'nope',
      ok: { command: 'node', args: ['s.js', 1] },
    })
    expect(out).toEqual({ ok: { command: 'node', args: ['s.js'], env: undefined } })
  })
  it('空输入返回 undefined', () => {
    expect(parseMcpServers(undefined)).toBeUndefined()
    expect(parseMcpServers({})).toBeUndefined()
    expect(parseMcpServers([])).toBeUndefined()
  })
})
