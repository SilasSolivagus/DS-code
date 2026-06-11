// test/helpers.ts
import type { ToolContext } from '../src/tools/types.js'

export function makeCtx(cwd: string): ToolContext {
  return { cwd: () => cwd, setCwd: () => {}, signal: new AbortController().signal, fileState: new Map() }
}
