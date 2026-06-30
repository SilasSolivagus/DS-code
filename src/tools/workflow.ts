// src/tools/workflow.ts
import { z } from 'zod'
import type OpenAI from 'openai'
import type { Tool } from './types.js'
import type { Usage } from '../api.js'
import { runWorkflow } from '../workflow/orchestrator.js'
import { makeInProcessBackend } from '../workflow/backend.js'
import { registerTask, updateTask, generateTaskId, enqueueNotification, getTask } from '../tasks.js'
import type { JournalRecord } from '../workflow/types.js'

const schema = z.object({
  script: z.string().optional().describe('内联 workflow 脚本（以 export const meta = {...} 开头）'),
  name: z.string().optional().describe('预定义 workflow 名'),
  scriptPath: z.string().optional().describe('磁盘脚本路径（优先级最高）'),
  args: z.any().optional().describe('注入为脚本全局 args 的 JSON 值'),
  resumeFromRunId: z.string().regex(/^wf_[a-z0-9-]{6,}$/).optional().describe('从既有 run 增量重跑'),
})

export interface WorkflowToolDeps {
  client: OpenAI
  onUsage: (u: Usage, model: string) => void
  sessionModel: string
  agents: { agentType: string; getSystemPrompt: () => string; outputSchema?: z.ZodTypeAny }[]
  runSubagent: (opts: any) => Promise<string | undefined>
  journalDir: string
  resolveModelAlias?: (m: string) => string
}

export function makeWorkflowTool(deps: WorkflowToolDeps): Tool<typeof schema> {
  return {
    name: 'Workflow',
    description: 'orchestrate subagents with deterministic JavaScript workflow. Use this tool for multi-step orchestration where control flow should be deterministic (loops, conditionals, fan-out) rather than model-driven.',
    inputSchema: schema,
    isReadOnly: true,
    needsPermission: () => false,
    async call(input, ctx) {
      const script = input.script ?? ''
      const taskId = generateTaskId('local_workflow')
      const abort = new AbortController()
      const progress: JournalRecord[] = []
      const backend = makeInProcessBackend({
        runSubagent: deps.runSubagent,
        sessionModel: deps.sessionModel,
        client: deps.client,
        onUsage: deps.onUsage,
        ctx,
        signal: abort.signal,
        agents: deps.agents,
        resolveModelAlias: deps.resolveModelAlias,
      })
      registerTask({
        id: taskId,
        type: 'local_workflow',
        status: 'running',
        description: 'workflow',
        startTime: Date.now(),
        outputFile: '',
        outputOffset: 0,
        notified: false,
        abortController: abort,
      })
      // 脱钩异步跑
      void runWorkflow({
        script,
        args: input.args,
        runId: input.resumeFromRunId,
        journalDir: deps.journalDir,
        backend,
        budget: { total: null, spent: () => 0, remaining: () => Infinity },
        onProgress: r => progress.push(r),
        abortSignal: abort.signal,
      }).then(res => {
        updateTask(taskId, { status: 'completed', result: JSON.stringify(res.result) })
        const t = getTask(taskId)
        if (t) enqueueNotification(t)
      }).catch(err => {
        updateTask(taskId, { status: 'failed', result: String(err?.message ?? err) })
        const t = getTask(taskId)
        if (t) enqueueNotification(t)
      })
      return JSON.stringify({
        status: 'async_launched',
        taskId,
        runId: input.resumeFromRunId ?? '(generating wf_...)',
        taskType: 'local_workflow',
      })
    },
  }
}
