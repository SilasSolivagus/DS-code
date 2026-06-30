// src/workflow/sandbox.ts
import vm from 'node:vm'
import type { WorkflowBudget } from './types.js'

export interface SandboxHooks {
  agent: (prompt: string, opts?: unknown) => Promise<unknown>
  parallel: (thunks: unknown[]) => Promise<unknown[]>
  pipeline: (items: unknown[], ...stages: unknown[]) => Promise<unknown[]>
  workflow: (nameOrRef: unknown, args?: unknown) => Promise<unknown>
  phase: (title: string) => void
  log: (message: string) => void
  budget: WorkflowBudget
}

const SYNC_SLICE_TIMEOUT_MS = 30000

/** 在 Node vm 沙箱跑确定性脚本体。原语注入为「VM 域内 async 蹦床」，脚本 await 的是 VM 域 promise。 */
export async function runSandbox(scriptBody: string, args: unknown, hooks: SandboxHooks, signal: AbortSignal): Promise<unknown> {
  const context = vm.createContext({ __proto__: null }, { codeGeneration: { strings: false, wasm: false } })

  // 蹦床工厂：host 函数 → VM 域内 async/同步函数（由 host 用 runInContext 在 VM 域造）
  const wrapAsync = vm.runInContext('(hostFn => async (...a) => hostFn(...a))', context) as (f: Function) => Function
  const wrapSync = vm.runInContext('(hostFn => (...a) => hostFn(...a))', context) as (f: Function) => Function
  const define = (name: string, value: unknown) =>
    Object.defineProperty(context, name, { value, writable: true, enumerable: true, configurable: true })

  // 异步原语
  define('agent', wrapAsync((p: string, o: unknown) => hooks.agent(p, o)))
  define('parallel', wrapAsync((t: unknown[]) => hooks.parallel(t)))
  define('pipeline', wrapAsync((items: unknown[], ...stages: unknown[]) => hooks.pipeline(items, ...stages)))
  define('workflow', wrapAsync((n: unknown, a: unknown) => hooks.workflow(n, a)))
  // 同步原语
  define('phase', wrapSync((t: string) => hooks.phase(t)))
  define('log', wrapSync((m: string) => hooks.log(m)))
  // budget：VM 域对象，方法是同步蹦床
  define('budget', vm.runInContext('({ __proto__: null })', context))
  Object.defineProperty(context.budget, 'total', { value: hooks.budget.total, enumerable: true })
  Object.defineProperty(context.budget, 'spent', { value: wrapSync(() => hooks.budget.spent()), enumerable: true })
  Object.defineProperty(context.budget, 'remaining', { value: wrapSync(() => hooks.budget.remaining()), enumerable: true })
  // args：VM 内 JSON.parse → context-native
  define('args', vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(args ?? null))})`, context))
  // console / timers
  define('console', vm.runInContext('({ __proto__: null, log(){}, error(){}, warn(){}, info(){}, debug(){} })', context))
  define('setTimeout', wrapSync((fn: Function, ms: number) => setTimeout(fn, ms)))
  define('clearTimeout', wrapSync((t: unknown) => clearTimeout(t as NodeJS.Timeout)))
  // 确定性运行期兜底：剔除非确定性符号（parse.ts 已静态拦截，这里是 backstop）
  vm.runInContext('delete globalThis.Date; if (typeof Math !== "undefined") delete Math.random; void 0', context)

  // 编译脚本为 async IIFE（top-level await 生效；import() 禁用）
  const script = new vm.Script(`(async () => { 'use strict';\n${scriptBody}\n})()`, {
    filename: 'workflow.js',
    importModuleDynamically: (() => { throw new Error('import() is not available in workflow scripts.') }) as unknown as undefined,
  })
  const vmPromise = script.runInContext(context, { timeout: SYNC_SLICE_TIMEOUT_MS })

  // host 侧 await VM promise：用 VM 域内 async 包装器把 VM promise settle 成 host 可观察
  const awaiter = vm.runInContext('(async v => ({ __proto__: null, v: await v }))', context) as (v: unknown) => Promise<{ v: unknown }>
  const onAbort = () => {} // abort 由各原语内部 hooks 透传（agent/parallel 经 backend signal）
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const settled = await awaiter(vmPromise)
    return settled.v
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
