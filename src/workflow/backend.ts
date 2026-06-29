// src/workflow/backend.ts
import type OpenAI from 'openai'
import { z } from 'zod'
import type { ToolContext } from '../tools/types.js'
import type { Usage } from '../api.js'
import type { AgentSpec, AgentEffort } from './types.js'

export interface WorkflowBackend {
  runAgent(spec: AgentSpec): Promise<{ status: 'ok' | 'error'; result: unknown }>
}

export function mapEffort(e?: AgentEffort): 'low' | 'medium' | 'high' | undefined {
  if (!e) return undefined
  if (e === 'xhigh' || e === 'max') return 'high'
  return e
}

export interface InProcessBackendDeps {
  runSubagent: (opts: any) => Promise<string | undefined>
  sessionModel: string
  client: OpenAI
  onUsage: (u: Usage, model: string) => void
  ctx: ToolContext
  signal: AbortSignal
  agents: { agentType: string; getSystemPrompt: () => string; outputSchema?: z.ZodTypeAny }[]
  resolveModelAlias?: (m: string) => string
}

/** 单实现：包 runSubagent，一次性 runAgent(spec)→结果。isolation:'remote' 拒（1:1 CC）。 */
export function makeInProcessBackend(deps: InProcessBackendDeps): WorkflowBackend {
  return {
    async runAgent(spec) {
      if (spec.opts.isolation === 'remote') {
        throw new Error("agent({isolation:'remote'}) is not available in this build.")
      }
      const effortLevel = mapEffort(spec.opts.effort)
      const model = spec.opts.model ? (deps.resolveModelAlias?.(spec.opts.model) ?? spec.opts.model) : deps.sessionModel
      const agentType = spec.opts.agentType ?? 'general-purpose'
      const def = deps.agents.find(a => a.agentType === agentType)
      const systemPrompt = def?.getSystemPrompt() ?? ''
      // schema：JSON Schema → 这里 v1 用 zod 透传层；若 def 有 outputSchema 用之，否则把 JSON Schema 包成 z.any 校验占位
      const outputSchema = spec.opts.schema ? z.any() : def?.outputSchema
      try {
        const raw = await deps.runSubagent({
          client: deps.client, onUsage: deps.onUsage, systemPrompt, userPrompt: spec.prompt,
          tools: [], model, outputSchema, ctx: deps.ctx, signal: deps.signal,
          agentId: spec.agentId, agentType,
          worktreePath: spec.opts.isolation === 'worktree' ? undefined : undefined, // worktree 由 orchestrator 预置（Task 10 接 worktree.ts）
          thinking: effortLevel !== undefined, effortLevel,
        })
        const result = spec.opts.schema && raw ? JSON.parse(raw) : raw
        return { status: 'ok', result: result ?? null }
      } catch {
        return { status: 'error', result: null }
      }
    },
  }
}
