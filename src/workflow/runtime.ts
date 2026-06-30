// src/workflow/runtime.ts
import os from 'node:os'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { SandboxHooks } from './sandbox.js'
import { runSandbox } from './sandbox.js'
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
  // 嵌套组合：解析 + parse → 子 workflow 的 scriptBody。缺省则 workflow() 不可用。
  loadWorkflowScript?: (nameOrRef: unknown) => string
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
  // ALS 把「结构化路径 + 嵌套深度」跨 await 传播；每路径一个本地序号计数，得到确定性 cache key。
  const als = new AsyncLocalStorage<{ path: string; depth?: number }>()
  const seqByPath = new Map<string, number>()
  const currentPath = () => als.getStore()?.path ?? ''
  // 取并自增某路径的本地序号（agent / workflow 共用同一计数器 → 同路径下确定性、无碰撞）。
  const nextSeqForPath = (path: string): number => {
    const seq = seqByPath.get(path) ?? 0
    seqByPath.set(path, seq + 1)
    return seq
  }

  async function agent(prompt: string, opts?: unknown): Promise<unknown> {
    const agentOpts: AgentOpts = (opts as AgentOpts) ?? {}
    const i = index++ // 单调计数：用于 agentId / 展示排序（与 cache 匹配解耦）
    // 结构化 cache key：当前路径 + 同路径序号。重跑同脚本同控制流必得相同 key，与并发完成顺序无关。
    const path = currentPath()
    const seq = nextSeqForPath(path)
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
    const depth = als.getStore()?.depth // 透传嵌套深度：子 workflow 内的 parallel 仍受一层限制约束
    const wrapped = (thunks as (() => Promise<unknown>)[]).map((t, k) => () => als.run({ path: childPath(parent, 'p' + k), depth }, t))
    return runWithCap(wrapped)
  }

  async function pipeline(items: unknown[], ...stages: unknown[]): Promise<unknown[]> {
    if (items.length > MAX_ITEMS) throw new Error(`A single parallel()/pipeline() call accepts at most ${MAX_ITEMS} items; passing more is an explicit error, not a silent truncation.`)
    const fns = stages as ((prev: unknown, orig: unknown, idx: number) => unknown)[]
    const parent = currentPath()
    const depth = als.getStore()?.depth // 透传嵌套深度：子 workflow 内的 pipeline 仍受一层限制约束
    // 每 item 独立穿全 stage，无 barrier；并发受 cap 约束。
    // item k 整条链在 'i<k>' 下，每个 stage s 调用在 'i<k>/s<s>' 下（k、s 均为确定性输入/阶段位）。
    const thunks = items.map((orig, k) => () => als.run({ path: childPath(parent, 'i' + k), depth }, async () => {
      let cur: unknown = orig
      for (let s = 0; s < fns.length; s++) {
        cur = await als.run({ path: childPath(parent, 'i' + k, 's' + s), depth }, () => fns[s](cur, orig, k))
      }
      return cur
    }))
    return runWithCap(thunks)
  }
  async function workflow(nameOrRef: unknown, a?: unknown): Promise<unknown> {
    // 一层限制：子 workflow 的 ALS store 带 depth:1，跨 await 传播，其内部 workflow() 在此被拦。
    const depth = als.getStore()?.depth ?? 0
    if (depth >= 1) throw new Error('Nesting is one level only: workflow() inside a child throws.')
    if (!deps.loadWorkflowScript) throw new Error('Nested workflow() is not available here.')
    const seq = nextSeqForPath(currentPath())
    const path = childPath(currentPath(), 'w' + seq)
    const childBody = deps.loadWorkflowScript(nameOrRef) // 未找到 / 子语法错 → 在此抛清晰错误
    // 复用「同一套 hooks」内联跑子 workflow：agent/parallel/pipeline 自动共享 agents 计数、
    // budget、abort、journal；缓存落在父结构化路径 w<seq>/... 下。所有共享均为自动行为。
    return als.run({ path, depth: 1 }, () => runSandbox(childBody, a, hooks, deps.abortSignal))
  }

  // 自引用 hooks：workflow() 需把「自身所在的 hooks 对象」作为子运行的 hooks 透传。
  // function 声明被提升，hooks 在其被调用前已初始化，闭包按引用捕获，安全。
  const hooks: SandboxHooks & { agentCount: () => number } = {
    agent, parallel, pipeline, workflow, phase, log, budget: deps.budget, agentCount: () => agents,
  }
  return hooks
}
