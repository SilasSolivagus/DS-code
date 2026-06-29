// src/tui/pasteFold.ts — 文本粘贴折叠（1:1 复刻 CC bundle v2.1.76）。纯逻辑。
export interface TextEntry { id: number; type: 'text'; content: string }
export interface ImageEntry { id: number; type: 'image'; base64: string; mime: string; source: 'file' | 'clipboard' }
export type Attachment = TextEntry | ImageEntry

export const PASTE_CHAR_THRESHOLD = 800   // CC DG1
export const TRUNCATE_LIMIT = 10000        // CC qfz
export const KEEP_HALF = 500               // CC Rxq/2

export function countNewlines(s: string): number {
  return (s.match(/\r\n|\r|\n/g) || []).length
}
export function normalizePaste(s: string): string {
  return s.replace(/\r\n|\r/g, '\n').replace(/\t/g, '    ').replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '')
}
export function newlineThreshold(rows: number): number { return Math.min(rows - 10, 2) }
export function shouldFold(text: string, rows: number): boolean {
  return text.length > PASTE_CHAR_THRESHOLD || countNewlines(text) > newlineThreshold(rows)
}
export function makePlaceholder(id: number, lines: number): string {
  return lines === 0 ? `[Pasted text #${id}]` : `[Pasted text #${id} +${lines} lines]`
}
export function makeTruncatePlaceholder(id: number, lines: number): string {
  return `[...Truncated text #${id} +${lines} lines...]`
}
export function truncateBuffer(text: string, id: number): { newText: string; entry: TextEntry } | null {
  if (text.length <= TRUNCATE_LIMIT) return null
  const head = text.slice(0, KEEP_HALF)
  const tail = text.slice(-KEEP_HALF)
  const mid = text.slice(KEEP_HALF, -KEEP_HALF)
  const ph = makeTruncatePlaceholder(id, countNewlines(mid))
  return { newText: head + ph + tail, entry: { id, type: 'text', content: mid } }
}
export const PLACEHOLDER_RE = /\[(Pasted text|\.\.\.Truncated text) #(\d+)(?: \+\d+ lines)?(\.)*\]/g
export function expandTextPlaceholders(text: string, map: Map<number, { content: string }>): string {
  return text.replace(PLACEHOLDER_RE, (m, _kind, idStr) => {
    const e = map.get(Number(idStr))
    return e ? e.content : m
  })
}
const TRAILING_RE = /(^|\s)\[(Pasted text #\d+(?: \+\d+ lines)?|\.\.\.Truncated text #\d+ \+\d+ lines\.\.\.)\]$/
export function stripTrailingPlaceholder(text: string): string | null {
  const m = text.match(TRAILING_RE)
  if (!m) return null
  return text.slice(0, m.index! + m[1].length)
}
