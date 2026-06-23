import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import type { Tool } from './types.js'
import { planDirFor } from '../memdir/paths.js'

const schema = z.object({
  plan: z.string().describe('给用户审批的实施计划（markdown）'),
  allowedPrompts: z.array(z.object({
    tool: z.literal('Bash'),
    prompt: z.string(),
  })).optional().describe('批准计划时一并放行的 Bash 语义操作（如 "run tests"）'),
})

export const exitPlanModeTool: Tool<typeof schema> = {
  name: 'ExitPlanMode',
  description:
    '在 plan 模式下写完计划、准备请用户批准时调用此工具。会把计划展示给用户审批；批准后退出 plan 模式开始执行。只在 plan 模式可用。',
  inputSchema: schema,
  isReadOnly: true,
  needsPermission: () => false,
  async call(input, ctx) {
    // 写盘计划作团队/云前向底座（未来 leader 审批 / cloud resume 回填的接入点）；当前仅持久化。
    const dir = planDirFor(ctx.cwd())
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, `${ctx.sessionId?.() ?? 'plan'}.md`)
    fs.writeFileSync(filePath, input.plan)
    return JSON.stringify({ plan: input.plan, isAgent: false, filePath })
  },
}
