// src/deny.ts
// 敏感路径 deny：内置私钥类默认列表 + picomatch glob 匹配（~展开、不 realpath，对齐 CC）。
import picomatch from 'picomatch'
import os from 'node:os'
import path from 'node:path'

/** 内置默认 deny（只含高敏私钥类；不含 .env 以免误伤读配置请求）。 */
export const BUILTIN_DENY = [
  '~/.ssh/**',
  '**/id_rsa',
  '**/id_ed25519',
  '**/id_dsa',
  '**/id_ecdsa',
  '~/.aws/credentials',
  '**/authorized_keys',
]

/** 转义 picomatch 元字符（仅用于 homedir 字面段，不影响 glob 后缀活性）。 */
function escapeGlob(s: string): string {
  return s.replace(/[()[\]{}!?*+@|^$.\\]/g, m => '\\' + m)
}

function expandTilde(p: string): string {
  if (p === '~') return escapeGlob(os.homedir())
  return p.startsWith('~/') ? escapeGlob(os.homedir()) + '/' + p.slice(2) : p
}

/** absPath 命中任一 deny pattern 则返回该 pattern，否则 null。逻辑路径匹配，不解符号链接。 */
export function isDeniedPath(absPath: string, patterns: string[]): string | null {
  const target = path.resolve(absPath)
  for (const pat of patterns) {
    if (picomatch.isMatch(target, expandTilde(pat), { dot: true })) return pat
  }
  return null
}

/** 运行时 deny 列表 = 内置默认 ∪ 用户配置。 */
export function resolveDenyList(userDeny?: string[]): string[] {
  return [...BUILTIN_DENY, ...(userDeny ?? [])]
}
