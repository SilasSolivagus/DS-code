import { execFileSync } from 'node:child_process'

export type SettingScope = 'user' | 'project' | 'local' | 'flag'

/** 整键剥离的危险字段（仅 project / git-tracked local）。 */
export const DANGEROUS_TOP_KEYS = [
  'apiKey', 'baseURL', 'hooks', 'mcpServers', 'webSearch',
  'allowedHttpHookUrls', 'httpHookAllowedEnvVars',
] as const

/** 深拷 raw 后剥离危险字段；嵌套删 permissions.allow / skills.sources。返回剥掉的键名（含嵌套路径）。 */
export function stripUntrustedScope(raw: any): { raw: any; stripped: string[] } {
  const out = raw && typeof raw === 'object' ? structuredClone(raw) : raw
  const stripped: string[] = []
  if (!out || typeof out !== 'object') return { raw: out, stripped }
  for (const k of DANGEROUS_TOP_KEYS) {
    if (out[k] !== undefined) { delete out[k]; stripped.push(k) }
  }
  if (out.permissions && typeof out.permissions === 'object' && out.permissions.allow !== undefined) {
    delete out.permissions.allow; stripped.push('permissions.allow')
  }
  if (out.skills && typeof out.skills === 'object' && out.skills.sources !== undefined) {
    delete out.skills.sources; stripped.push('skills.sources')
  }
  return { raw: out, stripped }
}

/** 文件是否被 git 跟踪（= repo 随身携带、非用户手写）。非 git 仓库 / git 不可用 → false。 */
export function isGitTracked(filePath: string, cwd: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', filePath], { cwd, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export interface ScopePartial { scope: SettingScope; partial: Record<string, unknown> }

const DEFAULT_SETTINGS: Record<string, unknown> = {
  permissions: { allow: [] as string[] },
  compactTokens: 200_000,
  costWarnCNY: 15,
  maxToolResultChars: 100_000,
}

function uniq<T>(arr: T[]): T[] { return [...new Set(arr)] }
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 深合并 src 进 target（就地）：数组 concat+去重、对象递归、标量覆盖。 */
function deepMergeInto(target: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue
    const cur = target[k]
    if (Array.isArray(cur) && Array.isArray(v)) target[k] = uniq([...cur, ...v])
    else if (isPlainObject(cur) && isPlainObject(v)) { const c = { ...cur }; deepMergeInto(c, v); target[k] = c }
    else target[k] = Array.isArray(v) ? [...v] : isPlainObject(v) ? { ...v } : v
  }
}

export function mergeScopePartials(layers: ScopePartial[]): {
  settings: any
  provenance: Record<string, SettingScope | 'merged'>
} {
  const settings: Record<string, unknown> = structuredClone(DEFAULT_SETTINGS)
  const contributors: Record<string, Set<SettingScope>> = {}
  const isArrayOrObject: Record<string, boolean> = {}

  for (const { scope, partial } of layers) {
    for (const k of Object.keys(partial)) {
      if (partial[k] === undefined) continue
      const v = partial[k]
      ;(contributors[k] ??= new Set()).add(scope)
      isArrayOrObject[k] = Array.isArray(v) || isPlainObject(v)
    }
    deepMergeInto(settings, partial)
  }

  const provenance: Record<string, SettingScope | 'merged'> = {}
  for (const [k, set] of Object.entries(contributors)) {
    // 对于数组/对象：多 scope 贡献则 merged；对于标量：最后一个 scope 覆盖
    if (isArrayOrObject[k] && set.size > 1) {
      provenance[k] = 'merged'
    } else {
      // 找最后一个设置该 key 的 scope
      for (let i = layers.length - 1; i >= 0; i--) {
        if (layers[i].partial[k] !== undefined) {
          provenance[k] = layers[i].scope
          break
        }
      }
    }
  }
  return { settings, provenance }
}
