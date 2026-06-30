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
import { notebookEditTool } from './notebookEdit.js'
import { exitPlanModeTool } from './exitPlanMode.js'
import { enterWorktreeTool } from './enterWorktree.js'
import { exitWorktreeTool } from './exitWorktree.js'
import { sleepTool } from './sleep.js'
import { scheduleWakeupTool } from './scheduleWakeup.js'
import { cronCreateTool, cronListTool, cronDeleteTool } from './cron.js'
import { monitorTool } from './monitor.js'
import { taskStopTool } from './taskStop.js'
import { pushNotificationTool } from './pushNotification.js'

export const allTools: Tool<any>[] = [readTool, globTool, grepTool, bashTool, editTool, writeTool, notebookEditTool, configTool, exitPlanModeTool, enterWorktreeTool, exitWorktreeTool, sleepTool, scheduleWakeupTool, cronCreateTool, cronListTool, cronDeleteTool, monitorTool, taskStopTool, pushNotificationTool]

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
