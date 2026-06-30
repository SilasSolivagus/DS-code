import { describe, it, expect } from 'vitest'
import { allTools, toApiTools } from '../src/tools/index.js'
import { readTool } from '../src/tools/read.js'

describe('registry', () => {
  it('注册了十六个工具（含 ExitPlanMode、EnterWorktree、ExitWorktree、Sleep、ScheduleWakeup、CronCreate、CronList、CronDelete）', () => {
    expect(allTools.map(t => t.name).sort()).toEqual(['Bash', 'Config', 'CronCreate', 'CronDelete', 'CronList', 'Edit', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree', 'Glob', 'Grep', 'NotebookEdit', 'Read', 'ScheduleWakeup', 'Sleep', 'Write'])
  })

  it('toApiTools 生成 OpenAI function 定义', () => {
    const api = toApiTools([readTool])
    expect(api[0].type).toBe('function')
    expect(api[0].function.name).toBe('Read')
    const params: any = api[0].function.parameters
    expect(params.type).toBe('object')
    expect(params.properties.file_path).toBeDefined()
    expect(params.required).toContain('file_path')
  })
})
