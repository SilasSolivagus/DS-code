// src/workflow/orchestrator.ts
import crypto from 'node:crypto'
import { join } from 'node:path'
import { parseWorkflow } from './parse.js'
import { runSandbox } from './sandbox.js'
import { resolveWorkflowScript } from './resolve.js'
import { LocalFileJournal } from './journal.js'
import { createRuntime } from './runtime.js'
import type { WorkflowBackend } from './backend.js'
import type { JournalRecord, WorkflowBudget } from './types.js'

export function generateRunId(rand: (n: number) => Buffer = crypto.randomBytes): string {
  return 'wf_' + rand(6).toString('hex').slice(0, 12)
}

export interface RunWorkflowOpts {
  script: string
  args: unknown
  runId?: string
  cwd?: string // 嵌套 workflow() 解析 .deepcode/workflows/<name>.js 的基准目录
  journalDir: string
  backend: WorkflowBackend
  budget: WorkflowBudget
  onProgress: (rec: JournalRecord) => void
  abortSignal: AbortSignal
}

export async function runWorkflow(opts: RunWorkflowOpts): Promise<{ runId: string; result: unknown; agents: number }> {
  const { meta, scriptBody } = parseWorkflow(opts.script)
  const runId = opts.runId ?? generateRunId()
  const journal = new LocalFileJournal(join(opts.journalDir, runId, 'journal.jsonl'))
  const records = await journal.load() // resume：预载历史
  const cwd = opts.cwd ?? process.cwd()
  // 嵌套加载器：闭包绑定 cwd，解析脚本源 → parse 校验（确定性/语法/meta）→ 返回 scriptBody
  const loadWorkflowScript = (nameOrRef: unknown): string => parseWorkflow(resolveWorkflowScript(nameOrRef, cwd)).scriptBody
  const runtime = createRuntime({
    backend: opts.backend, journal, records, budget: opts.budget,
    onProgress: opts.onProgress, abortSignal: opts.abortSignal, loadWorkflowScript,
  })
  await journal.append({ type: 'workflow_start', runId, name: meta.name })
  const start = (globalThis.performance?.now?.() ?? 0)
  const result = await runSandbox(scriptBody, opts.args, runtime, opts.abortSignal)
  const ms = Math.round((globalThis.performance?.now?.() ?? 0) - start)
  const agents = runtime.agentCount()
  await journal.append({ type: 'workflow_complete', runId, agents, ms })
  return { runId, result, agents }
}
