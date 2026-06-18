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
