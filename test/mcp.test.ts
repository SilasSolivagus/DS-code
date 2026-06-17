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

import { serializeContent } from '../src/mcp.js'
import { z } from 'zod'
import { wrapMcpTool } from '../src/mcp.js'
import type { ToolContext } from '../src/tools/types.js'

const ctx = { signal: new AbortController().signal } as unknown as ToolContext

describe('wrapMcpTool', () => {
  const mcpTool = {
    name: 'create_issue',
    description: '创建 issue',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    annotations: { readOnlyHint: false },
  }

  it('名/描述/schema 透传，非只读需权限', () => {
    const client = { callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }
    const t = wrapMcpTool(client as any, 'github', mcpTool as any)
    expect(t.name).toBe('mcp__github__create_issue')
    expect(t.description).toBe('创建 issue')
    expect(t.rawJsonSchema).toEqual(mcpTool.inputSchema)
    expect(t.isReadOnly).toBe(false)
    expect(t.needsPermission({})).toBe('github: create_issue')
  })

  it('readOnlyHint=true → 只读、免权限', () => {
    const client = { callTool: async () => ({ content: [] }) }
    const t = wrapMcpTool(client as any, 'github', { ...mcpTool, annotations: { readOnlyHint: true } } as any)
    expect(t.isReadOnly).toBe(true)
    expect(t.needsPermission({})).toBe(false)
  })

  it('call 用原始 tool 名路由，序列化 content', async () => {
    let received: any
    const client = { callTool: async (a: any) => { received = a; return { content: [{ type: 'text', text: 'done' }] } } }
    const t = wrapMcpTool(client as any, 'github', mcpTool as any)
    const out = await t.call({ title: 'x' }, ctx)
    expect(received.name).toBe('create_issue')
    expect(received.arguments).toEqual({ title: 'x' })
    expect(out).toBe('done')
  })

  it('isError=true → 抛错', async () => {
    const client = { callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }) }
    const t = wrapMcpTool(client as any, 'github', mcpTool as any)
    await expect(t.call({}, ctx)).rejects.toThrow('boom')
  })
})

describe('serializeContent', () => {
  it('text block 取 text', () => {
    expect(serializeContent([{ type: 'text', text: 'hello' }])).toBe('hello')
  })
  it('多 block 用换行连接', () => {
    expect(serializeContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb')
  })
  it('resource block 取内嵌 text', () => {
    expect(serializeContent([{ type: 'resource', resource: { uri: 'x', text: 'rt' } }])).toBe('rt')
  })
  it('未知 block 序列化为 JSON', () => {
    expect(serializeContent([{ type: 'image', data: 'b64' }])).toBe('{"type":"image","data":"b64"}')
  })
  it('非数组兜底', () => {
    expect(serializeContent('raw')).toBe('raw')
    expect(serializeContent({ a: 1 })).toBe('{"a":1}')
  })
})
