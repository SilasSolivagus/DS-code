export const JITTER = {
  recurringFrac: 0.5,
  recurringCapMs: 1_800_000,   // 30min
  oneShotMaxMs: 90_000,        // 90s
  recurringMaxAgeMs: 604_800_000, // 7天
} as const

const BOUNDS: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]

// Parse single field to array of allowed values. Supports * / N / N-M / a,b,c / */K
// Returns null on out-of-bounds or invalid syntax
function parseField(raw: string, lo: number, hi: number): number[] | null {
  const out = new Set<number>()
  for (const part of raw.split(',')) {
    let step = 1
    let body = part
    const slash = part.indexOf('/')
    if (slash >= 0) {
      const s = Number(part.slice(slash + 1))
      if (!Number.isInteger(s) || s <= 0) return null
      step = s
      body = part.slice(0, slash)
    }
    let from = lo, to = hi
    if (body === '*') { /* wildcard */ }
    else if (body.includes('-')) {
      const [a, b] = body.split('-')
      from = Number(a); to = Number(b)
      if (!Number.isInteger(from) || !Number.isInteger(to)) return null
    } else {
      const n = Number(body)
      if (!Number.isInteger(n)) return null
      from = to = n
    }
    if (from < lo || to > hi || from > to) return null
    for (let v = from; v <= to; v += step) out.add(v)
  }
  return [...out].sort((a, b) => a - b)
}

// 5-field to [minutes,hours,doms,months,dows]; returns null on invalid field count/bounds/syntax
export function parseCron(expr: string): number[][] | null {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const parsed: number[][] = []
  for (let i = 0; i < 5; i++) {
    const f = parseField(fields[i], BOUNDS[i][0], BOUNDS[i][1])
    if (f === null) return null
    parsed.push(f)
  }
  return parsed
}

export function cronMatches(expr: string, d: Date): boolean {
  const p = parseCron(expr)
  if (!p) return false
  const dow = d.getDay() // 0=Sunday
  const dowOk = p[4].includes(dow) || (dow === 0 && p[4].includes(7)) || (p[4].includes(0) && dow === 7)
  return p[0].includes(d.getMinutes())
    && p[1].includes(d.getHours())
    && p[2].includes(d.getDate())
    && p[3].includes(d.getMonth() + 1)
    && dowOk
}

// Find earliest match strictly after 'after' (minute precision)
// Scans up to 366 days, returns null if no match found
export function nextFire(expr: string, after: Date): Date | null {
  if (!parseCron(expr)) return null
  const t = new Date(after.getTime())
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1) // start from next whole minute
  const limit = 366 * 24 * 60
  for (let i = 0; i < limit; i++) {
    if (cronMatches(expr, t)) return new Date(t.getTime())
    t.setMinutes(t.getMinutes() + 1)
  }
  return null
}

export function clampDelaySeconds(s: number): number {
  if (Number.isNaN(s)) return 60
  if (s === Infinity) return 3600
  if (s === -Infinity) return 60
  return Math.max(60, Math.min(3600, Math.round(s)))
}

// Round up now + delaySeconds to next whole minute, return absolute ms
export function roundUpToMinute(now: number, delaySeconds: number): number {
  const target = now + delaySeconds * 1000
  const d = new Date(target)
  if (d.getSeconds() !== 0 || d.getMilliseconds() !== 0) {
    d.setSeconds(0, 0)
    d.setMinutes(d.getMinutes() + 1)
  }
  return d.getTime()
}

// Deterministic jitter derived from id hash, falls in [0, cap]
export function jitterMs(id: string, periodMs: number, recurring: boolean): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  const cap = recurring
    ? Math.min(periodMs * JITTER.recurringFrac, JITTER.recurringCapMs)
    : JITTER.oneShotMaxMs
  return cap <= 0 ? 0 : h % Math.floor(cap)
}
