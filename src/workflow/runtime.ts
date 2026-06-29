// src/workflow/runtime.ts
import os from 'node:os'
import type { SandboxHooks } from './sandbox.js'
import type { WorkflowBackend } from './backend.js'
import type { LocalFileJournal } from './journal.js'
import { cachedAgent, optsKeyOf } from './journal.js'
import type { JournalRecord, WorkflowBudget, AgentOpts } from './types.js'

export const MAX_CONCURRENCY = Math.max(1, Math.min(16, os.cpus().length - 2))
export const MAX_AGENTS = 1000
export const MAX_ITEMS = 4096

export interface RuntimeDeps {
  backend: WorkflowBackend
  journal: LocalFileJournal
  records: JournalRecord[] // resume 时预载的历史
  budget: WorkflowBudget
  onProgress: (rec: JournalRecord) => void
  abortSignal: AbortSignal
  resolveWorkflow?: (nameOrRef: unknown, args: unknown) => Promise<unknown>
}

export function createRuntime(deps: RuntimeDeps): SandboxHooks & { agentCount: () => number } {
  let index = 0
  let agents = 0
  let phaseIndex = -1
  let phaseTitle: string | undefined

  async function agent(prompt: string, opts?: unknown): Promise<unknown> {
    const agentOpts: AgentOpts = (opts as AgentOpts) ?? {}
    const i = index++
    if (agents >= MAX_AGENTS) throw new Error(`Total agent count across a workflow's lifetime is capped at ${MAX_AGENTS} — a runaway-loop backstop.`)
    if (deps.budget.total != null && deps.budget.remaining() <= 0) throw new Error('Workflow token budget exhausted: spent() reached total, further agent() calls throw.')
    const optsKey = optsKeyOf(agentOpts)
    const cache = cachedAgent(deps.records, i, prompt, optsKey)
    if (cache.hit) return cache.result
    agents++
    const agentId = `wfa_${i}`
    const out = await deps.backend.runAgent({ prompt, opts: agentOpts, agentId, index: i })
    const status = out.status === 'ok' ? 'ok' : 'error'
    const rec: JournalRecord = { type: 'workflow_agent', index: i, label: agentOpts.label, phaseIndex: phaseIndex < 0 ? undefined : phaseIndex, phaseTitle, agentId, model: agentOpts.model ?? '', status, prompt, optsKey, result: out.result }
    await deps.journal.append(rec)
    deps.onProgress(rec)
    return out.status === 'ok' ? out.result : null
  }

  function phase(title: string): void {
    phaseIndex++
    phaseTitle = title
    const rec: JournalRecord = { type: 'workflow_phase', index: index, title, phaseIndex }
    void deps.journal.append(rec)
    deps.onProgress(rec)
  }

  function log(message: string): void {
    const rec: JournalRecord = { type: 'workflow_log', index, message }
    void deps.journal.append(rec)
    deps.onProgress(rec)
  }

  async function parallel(): Promise<unknown[]> { throw new Error('implemented in Task 8') }
  async function pipeline(): Promise<unknown[]> { throw new Error('implemented in Task 8') }
  async function workflow(nameOrRef: unknown, a?: unknown): Promise<unknown> {
    if (!deps.resolveWorkflow) throw new Error('Nested workflow() is not available here.')
    return deps.resolveWorkflow(nameOrRef, a)
  }

  return { agent, parallel, pipeline, workflow, phase, log, budget: deps.budget, agentCount: () => agents }
}
