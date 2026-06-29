// src/workflow/parse.ts
import vm from 'node:vm'
import type { WorkflowMeta } from './types.js'

export class WorkflowParseError extends Error {
  constructor(public code: 'syntax' | 'deterministic' | 'plainjs' | 'meta', message: string) {
    super(message)
    this.name = 'WorkflowParseError'
  }
}

const DETERMINISM_RE = /\b(Date\.now\s*\(|Math\.random\s*\(|new\s+Date\b)/
// 粗粒度 TS 语法侦测：类型注解 `: Type`（非对象字面量/三元）、interface/enum、泛型尖括号调用
const TS_RE = /(\binterface\s+[A-Za-z]|\benum\s+[A-Za-z]|:\s*(string|number|boolean|any|void|unknown)\b(\[\])?\s*[=,)])/

/** 拆 `export const meta = {...}` 字面量（AST 不求值）+ 校验脚本体。 */
export function parseWorkflow(script: string): { meta: WorkflowMeta; scriptBody: string } {
  // 1. 提取 meta 字面量（要求形如 export const meta = { ... }）
  const m = script.match(/export\s+const\s+meta\s*=\s*(\{[\s\S]*?\})\s*(?:\n|;|$)/)
  if (!m) throw new WorkflowParseError('meta', "Workflow script must start with `export const meta = {...}` (a pure object literal).")
  const metaLiteral = m[1]
  let meta: WorkflowMeta
  try {
    // 在隔离 context 求值「单个对象字面量」——不暴露任何全局，纯字面量无副作用
    const evalCtx = vm.createContext({ __proto__: null }, { codeGeneration: { strings: false, wasm: false } })
    meta = vm.runInContext(`(${metaLiteral})`, evalCtx, { timeout: 1000 }) as WorkflowMeta
  } catch {
    throw new WorkflowParseError('meta', 'Workflow `meta` must be a pure object literal (no variables, function calls, spreads, or template interpolation).')
  }
  if (!meta || typeof meta.name !== 'string' || typeof meta.description !== 'string') {
    throw new WorkflowParseError('meta', 'Workflow `meta` requires string fields `name` and `description`.')
  }
  // scriptBody = 去掉 meta 声明后的剩余
  const scriptBody = script.slice(0, m.index) + script.slice((m.index ?? 0) + m[0].length)
  // 2. 确定性静态扫描
  if (DETERMINISM_RE.test(scriptBody)) {
    throw new WorkflowParseError('deterministic', 'Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.')
  }
  // 3. 纯 JS（非 TS）
  if (TS_RE.test(scriptBody)) {
    throw new WorkflowParseError('plainjs', "Workflow scripts must be plain JavaScript — TypeScript syntax (type annotations like `: string[]`, interfaces, generics) fails to parse.")
  }
  // 4. 编译校验语法（async IIFE 包装 → top-level await 合法）
  try {
    new vm.Script(`(async () => { 'use strict';\n${scriptBody}\n})()`, { filename: 'workflow.js' })
  } catch (e) {
    throw new WorkflowParseError('syntax', `Workflow script has a syntax error and was not run: ${(e as Error).message}`)
  }
  return { meta, scriptBody }
}
