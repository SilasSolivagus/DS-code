export type ClassifierDecision = 'run' | 'ask' | 'block'

// 只收最硬、最低误报的不可逆灾难。命令内容维度高置信匹配；代码语义弱信号交给分类器提示词。
export const HARD_DENY_PATTERNS: RegExp[] = [
  /\bcurl\b[^|]*\|\s*(ba)?sh\b/i,                 // curl … | sh/bash
  /\bwget\b[^|]*\|\s*(ba)?sh\b/i,                 // wget … | sh
  /\b(ba)?sh\s+<\(\s*curl/i,                       // bash <(curl …)
  /\/tmp\/\S+[^\n]*&&[^\n]*(\bsh\b|\bbash\b|\/tmp\/)/i, // 下载到 /tmp 后 && 执行（chmod 或直接跑）
  /@\s*(\$HOME|~|\.)?[^\s]*(\.ssh\/id_|\.aws\/cred|\.env|\.npmrc|credentials)/i, // -d @<secret>
  /(cat|grep|env|history)\b[^|]*\|\s*(curl|nc|netcat|ftp)\b/i,  // 管 secret 出网
  />>\s*~?\/?[^\s]*\.ssh\/authorized_keys/i,       // 写 authorized_keys 后门
  /\|\s*crontab\b/i,                               // 写 crontab 后门
  />>\s*~?\/?[^\s]*(\.bashrc|\.zshrc|\.profile)/i,  // 写 shell rc 后门
]

export function matchHardDeny(toolName: string, desc: string): boolean {
  const s = desc.replace(/\n/g, ' ')
  return HARD_DENY_PATTERNS.some(re => re.test(s))
}

export function parseDecision(raw: string): ClassifierDecision | null {
  if (!raw) return null
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const d = JSON.parse(m[0]).decision
    return d === 'run' || d === 'ask' || d === 'block' ? d : null
  } catch { return null }
}

export function mapDecision(d: ClassifierDecision | null): 'run' | 'ask' | 'block' {
  return d ?? 'ask' // fail-safe：解析失败/不确定 → ask
}
