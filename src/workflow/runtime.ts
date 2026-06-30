// src/workflow/runtime.ts
import os from 'node:os'
import { AsyncLocalStorage } from 'node:async_hooks'
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

// 结构化路径拼接：空段过滤，'/' 分隔。根路径为 ''。
function childPath(parent: string, ...segs: string[]): string {
  return [parent, ...segs].filter(Boolean).join('/')
}

export function createRuntime(deps: RuntimeDeps): SandboxHooks & { agentCount: () => number } {
  let index = 0
  let agents = 0
  let phaseIndex = -1
  let phaseTitle: string | undefined
  // ALS 把「结构化路径」跨 await 传播；每路径一个本地序号计数，得到确定性 cache key。
  const als = new AsyncLocalStorage<{ path: string }>()
  const seqByPath = new Map<string, number>()
  const currentPath = () => als.getStore()?.path ?? ''

  async function agent(prompt: string, opts?: unknown): Promise<unknown> {
    const agentOpts: AgentOpts = (opts as AgentOpts) ?? {}
    const i = index++ // 单调计数：用于 agentId / 展示排序（与 cache 匹配解耦）
    // 结构化 cache key：当前路径 + 同路径序号。重跑同脚本同控制流必得相同 key，与并发完成顺序无关。
    const path = currentPath()
    const seq = seqByPath.get(path) ?? 0
    seqByPath.set(path, seq + 1)
    const key = `${path}#${seq}`
    if (agents >= MAX_AGENTS) throw new Error(`Total agent count across a workflow's lifetime is capped at ${MAX_AGENTS} — a runaway-loop backstop.`)
    if (deps.budget.total != null && deps.budget.remaining() <= 0) throw new Error('Workflow token budget exhausted: spent() reached total, further agent() calls throw.')
    const optsKey = optsKeyOf(agentOpts)
    const cache = cachedAgent(deps.records, key, prompt, optsKey)
    if (cache.hit) return cache.result
    agents++
    const agentId = `wfa_${i}`
    const out = await deps.backend.runAgent({ prompt, opts: agentOpts, agentId, index: i })
    const status = out.status === 'ok' ? 'ok' : 'error'
    const rec: JournalRecord = { type: 'workflow_agent', index: i, key, label: agentOpts.label, phaseIndex: phaseIndex < 0 ? undefined : phaseIndex, phaseTitle, agentId, model: agentOpts.model ?? '', status, prompt, optsKey, result: out.result }
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

  // 并发上限调度：跑 thunks，最多 MAX_CONCURRENCY 在途，结果保序，throw→null
  async function runWithCap<T>(thunks: (() => Promise<T>)[]): Promise<(T | null)[]> {
    const results: (T | null)[] = new Array(thunks.length).fill(null)
    let next = 0
    async function worker() {
      while (next < thunks.length) {
        const i = next++
        try { results[i] = await thunks[i]() } catch { results[i] = null }
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, thunks.length) }, worker))
    return results
  }

  async function parallel(thunks: unknown[]): Promise<unknown[]> {
    if (!Array.isArray(thunks) || thunks.some(t => typeof t !== 'function')) {
      throw new Error('parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)')
    }
    if (thunks.length > MAX_ITEMS) throw new Error(`A single parallel()/pipeline() call accepts at most ${MAX_ITEMS} items; passing more is an explicit error, not a silent truncation.`)
    // 每 thunk 在结构化子路径 'p<k>' 下运行（k=输入序，非完成序）→ 内部 agent() 读到确定性路径。
    const parent = currentPath()
    const wrapped = (thunks as (() => Promise<unknown>)[]).map((t, k) => () => als.run({ path: childPath(parent, 'p' + k) }, t))
    return runWithCap(wrapped)
  }

  async function pipeline(items: unknown[], ...stages: unknown[]): Promise<unknown[]> {
    if (items.length > MAX_ITEMS) throw new Error(`A single parallel()/pipeline() call accepts at most ${MAX_ITEMS} items; passing more is an explicit error, not a silent truncation.`)
    const fns = stages as ((prev: unknown, orig: unknown, idx: number) => unknown)[]
    const parent = currentPath()
    // 每 item 独立穿全 stage，无 barrier；并发受 cap 约束。
    // item k 整条链在 'i<k>' 下，每个 stage s 调用在 'i<k>/s<s>' 下（k、s 均为确定性输入/阶段位）。
    const thunks = items.map((orig, k) => () => als.run({ path: childPath(parent, 'i' + k) }, async () => {
      let cur: unknown = orig
      for (let s = 0; s < fns.length; s++) {
        cur = await als.run({ path: childPath(parent, 'i' + k, 's' + s) }, () => fns[s](cur, orig, k))
      }
      return cur
    }))
    return runWithCap(thunks)
  }
  async function workflow(nameOrRef: unknown, a?: unknown): Promise<unknown> {
    if (!deps.resolveWorkflow) throw new Error('Nested workflow() is not available here.')
    return deps.resolveWorkflow(nameOrRef, a)
  }

  return { agent, parallel, pipeline, workflow, phase, log, budget: deps.budget, agentCount: () => agents }
}
