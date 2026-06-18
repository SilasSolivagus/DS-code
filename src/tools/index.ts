// src/tools/index.ts
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from './types.js'
import { readTool } from './read.js'
import { globTool } from './glob.js'
import { grepTool } from './grep.js'
import { bashTool } from './bash.js'
import { editTool } from './edit.js'
import { writeTool } from './write.js'
import { configTool } from './configTool.js'

export const allTools: Tool<any>[] = [readTool, globTool, grepTool, bashTool, editTool, writeTool, configTool]

export function toApiTools(tools: Tool<any>[]) {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.rawJsonSchema ?? zodToJsonSchema(t.inputSchema, { $refStrategy: 'none' }),
    },
  }))
}
