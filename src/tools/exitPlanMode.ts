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

export type PlanApprovalResult = { approved: boolean }
export type AllowedPrompt = { tool: 'Bash'; prompt: string }

/** 静态版（无审批回调）：仅写盘，用于 headless/子代理场景。 */
export const exitPlanModeTool: Tool<typeof schema> = {
  name: 'ExitPlanMode',
  description:
    '在 plan 模式下写完计划、准备请用户批准时调用此工具。会把计划展示给用户审批；批准后退出 plan 模式开始执行。只在 plan 模式可用。',
  inputSchema: schema,
  isReadOnly: true,
  needsPermission: () => false,
  async call(input, ctx) {
    const dir = planDirFor(ctx.cwd())
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, `${ctx.sessionId?.() ?? 'plan'}.md`)
    fs.writeFileSync(filePath, input.plan)
    return JSON.stringify({ plan: input.plan, isAgent: false, filePath })
  },
}

/** 工厂版（TUI 场景）：注入审批回调，工具调用时挂起直到用户审批完成。 */
export function makeExitPlanModeTool(deps: {
  approvePlan: (plan: string, allowedPrompts?: AllowedPrompt[]) => Promise<PlanApprovalResult>
}): Tool<typeof schema> {
  return {
    name: 'ExitPlanMode',
    description: exitPlanModeTool.description,
    inputSchema: schema,
    isReadOnly: true,
    needsPermission: () => false,
    async call(input, ctx) {
      // 写盘（底座）
      const dir = planDirFor(ctx.cwd())
      fs.mkdirSync(dir, { recursive: true })
      const filePath = path.join(dir, `${ctx.sessionId?.() ?? 'plan'}.md`)
      fs.writeFileSync(filePath, input.plan)
      // 等待 TUI 审批
      const result = await deps.approvePlan(input.plan, input.allowedPrompts)
      if (result.approved) {
        return JSON.stringify({ plan: input.plan, isAgent: false, filePath, approved: true })
      } else {
        return JSON.stringify({ plan: input.plan, isAgent: false, filePath, approved: false,
          feedback: '用户拒绝了该计划，请根据此反馈修改计划后重新调用 ExitPlanMode。' })
      }
    },
  }
}
