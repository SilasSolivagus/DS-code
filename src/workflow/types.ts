export interface WorkflowMeta {
  name: string
  description: string
  phases?: { title: string; detail?: string }[]
  model?: string
}

export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AgentOpts {
  label?: string
  phase?: string
  schema?: Record<string, unknown> // JSON Schema
  model?: string
  effort?: AgentEffort
  isolation?: 'worktree' | 'remote'
  agentType?: string
}

/** backend.runAgent 的入参（runtime 把 prompt+opts 归一成它）。 */
export interface AgentSpec {
  prompt: string
  opts: AgentOpts
  agentId: string
  index: number
}

export type JournalRecord =
  | { type: 'workflow_start'; runId: string; name: string }
  | { type: 'workflow_agent'; index: number; label?: string; phaseIndex?: number; phaseTitle?: string; agentId: string; model: string; status: 'ok' | 'error' | 'skipped'; prompt: string; optsKey: string; result: unknown }
  | { type: 'workflow_log'; index: number; message: string }
  | { type: 'workflow_phase'; index: number; title: string; phaseIndex: number }
  | { type: 'workflow_tool'; index: number; name: string }
  | { type: 'workflow_complete'; runId: string; agents: number; ms: number }

export interface WorkflowBudget {
  total: number | null
  spent: () => number
  remaining: () => number
}
