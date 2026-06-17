import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initMcpTools } from '../src/mcp.js'
import type { ToolContext } from '../src/tools/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, 'fixtures', 'mcp-echo-server.mjs')
const ctx = { signal: new AbortController().signal } as unknown as ToolContext

describe('MCP stdio 集成（真子进程）', () => {
  it('连真 echo server，发现工具并调用', async () => {
    const { tools, cleanup } = await initMcpTools({ echo: { command: process.execPath, args: [fixture] } })
    try {
      const echo = tools.find(t => t.name === 'mcp__echo__echo')
      expect(echo).toBeDefined()
      expect(echo!.isReadOnly).toBe(true)
      const out = await echo!.call({ msg: 'hi' }, ctx)
      expect(out).toBe('echo: hi')
    } finally {
      await cleanup()
    }
  }, 20_000)

  it('命令不存在的 server 被跳过、不抛', async () => {
    const warns: string[] = []
    const { tools, cleanup } = await initMcpTools(
      { nope: { command: 'definitely-not-a-real-binary-xyz' } },
      { onWarn: m => warns.push(m) },
    )
    expect(tools).toEqual([])
    expect(warns.length).toBe(1)
    await cleanup()
  }, 20_000)
})
