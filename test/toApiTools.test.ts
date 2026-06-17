import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { toApiTools } from '../src/tools/index.js'
import type { Tool } from '../src/tools/types.js'

describe('toApiTools rawJsonSchema 透传', () => {
  it('有 rawJsonSchema 时直接用它，不走 zodToJsonSchema', () => {
    const raw = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] }
    const tool: Tool = {
      name: 'mcp__s__t', description: 'd', inputSchema: z.object({}).passthrough(),
      rawJsonSchema: raw, isReadOnly: true, needsPermission: () => false, call: async () => 'ok',
    }
    expect(toApiTools([tool])[0].function.parameters).toEqual(raw)
  })
  it('无 rawJsonSchema 时仍走 zodToJsonSchema', () => {
    const tool: Tool = {
      name: 'X', description: 'd', inputSchema: z.object({ a: z.string() }),
      isReadOnly: true, needsPermission: () => false, call: async () => 'ok',
    }
    const params = toApiTools([tool])[0].function.parameters as any
    expect(params.type).toBe('object')
    expect(params.properties.a).toBeDefined()
  })
})
