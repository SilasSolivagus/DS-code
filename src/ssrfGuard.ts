import { lookup as dnsLookup } from 'node:dns'
import { isIP } from 'node:net'

/** true = HTTP hook 不应到达该地址（私网/链路本地/CGNAT/元数据）。loopback 放行。 */
export function isBlockedAddress(address: string): boolean {
  const v = isIP(address)
  if (v === 4) return isBlockedV4(address)
  if (v === 6) return isBlockedV6(address)
  return false
}

function isBlockedV4(address: string): boolean {
  const parts = address.split('.').map(Number)
  const [a, b] = parts
  if (parts.length !== 4 || a === undefined || b === undefined || parts.some(n => Number.isNaN(n))) return false
  if (a === 127) return false           // loopback 放行
  if (a === 0) return true              // 0.0.0.0/8
  if (a === 10) return true             // 10/8
  if (a === 169 && b === 254) return true   // 169.254/16 元数据
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT
  if (a === 192 && b === 168) return true   // 192.168/16
  return false
}

function isBlockedV6(address: string): boolean {
  const lower = address.toLowerCase()
  if (lower === '::1') return false     // loopback 放行
  if (lower === '::') return true
  const mapped = extractMappedIPv4(lower)
  if (mapped !== null) return isBlockedV4(mapped)
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // fc00::/7
  const first = lower.split(':')[0]
  if (first && first.length === 4 && first >= 'fe80' && first <= 'febf') return true // fe80::/10
  return false
}

function expandIPv6Groups(addr: string): number[] | null {
  let tail: number[] = []
  if (addr.includes('.')) {
    const lastColon = addr.lastIndexOf(':')
    const v4 = addr.slice(lastColon + 1)
    addr = addr.slice(0, lastColon)
    const oct = v4.split('.').map(Number)
    if (oct.length !== 4 || oct.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null
    tail = [(oct[0]! << 8) | oct[1]!, (oct[2]! << 8) | oct[3]!]
  }
  const dbl = addr.indexOf('::')
  let head: string[]; let rest: string[]
  if (dbl === -1) { head = addr.split(':'); rest = [] }
  else {
    const h = addr.slice(0, dbl); const t = addr.slice(dbl + 2)
    head = h === '' ? [] : h.split(':'); rest = t === '' ? [] : t.split(':')
  }
  const target = 8 - tail.length
  const fill = target - head.length - rest.length
  if (fill < 0) return null
  const hex = [...head, ...new Array<string>(fill).fill('0'), ...rest]
  const nums = hex.map(h => parseInt(h, 16))
  if (nums.some(n => Number.isNaN(n) || n < 0 || n > 0xffff)) return null
  nums.push(...tail)
  return nums.length === 8 ? nums : null
}

function extractMappedIPv4(addr: string): string | null {
  const g = expandIPv6Groups(addr)
  if (!g) return null
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    const hi = g[6]!; const lo = g[7]!
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
  }
  // NAT64 well-known prefix 64:ff9b::/96 — embedded IPv4 in low 32 bits
  if (
    g[0] === 0x0064 &&
    g[1] === 0xff9b &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    g[5] === 0
  ) {
    const hi = g[6]!
    const lo = g[7]!
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
  }
  return null
}

function ssrfError(hostname: string, address: string): NodeJS.ErrnoException {
  const err = new Error(`HTTP hook blocked: ${hostname} 解析到 ${address}（私网/链路本地）。loopback(127.0.0.1, ::1) 放行。`)
  return Object.assign(err, { code: 'ERR_HTTP_HOOK_BLOCKED_ADDRESS', hostname, address })
}

/** dns.lookup 兼容签名：用作 undici Agent connect.lookup，使「校验 IP = 连接 IP」消灭 rebinding 窗口。 */
export function ssrfGuardedLookup(
  hostname: string,
  options: object,
  callback: (err: Error | null, address: any, family?: number) => void,
): void {
  const wantsAll = 'all' in options && (options as any).all === true
  const v = isIP(hostname)
  if (v !== 0) {
    if (isBlockedAddress(hostname)) { callback(ssrfError(hostname, hostname), ''); return }
    const family = v === 6 ? 6 : 4
    if (wantsAll) callback(null, [{ address: hostname, family }])
    else callback(null, hostname, family)
    return
  }
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) { callback(err, ''); return }
    for (const { address } of addresses) {
      if (isBlockedAddress(address)) { callback(ssrfError(hostname, address), ''); return }
    }
    const first = addresses[0]
    if (!first) { callback(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', hostname }), ''); return }
    const family = first.family === 6 ? 6 : 4
    if (wantsAll) callback(null, addresses.map(a => ({ address: a.address, family: a.family === 6 ? 6 : 4 })))
    else callback(null, first.address, family)
  })
}

/** NO_PROXY 是否豁免该 URL 的 host（豁免 = 直连，不走代理）。逗号分隔后缀匹配。 */
export function shouldBypassProxy(url: string, noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? ''): boolean {
  if (!noProxy.trim()) return false
  let host: string
  try { host = new URL(url).hostname } catch { return false }
  return noProxy.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).some(entry => {
    const e = entry.replace(/^\*?\.?/, '') // 去前导 * 或 .
    return host === e || host.endsWith('.' + e) || host === entry
  })
}
