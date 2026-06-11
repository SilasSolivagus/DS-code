// src/tools/index.ts
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from './types.js'
import { readTool } from './read.js'
import { globTool } from './glob.js'
import { grepTool } from './grep.js'
import { bashTool } from './bash.js'

export const allTools: Tool<any>[] = [readTool, globTool, grepTool, bashTool]

export function toApiTools(tools: Tool<any>[]) {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.inputSchema, { $refStrategy: 'none' }),
    },
  }))
}
