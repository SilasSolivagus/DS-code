// src/clipboardImage.ts — 拖入图片文件 / 剪贴板截图 读为 base64（mac 优先）。
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

export const IMAGE_EXT_RE = /\.(png|jpe?g)$/i
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export function mimeForPath(p: string): string | null {
  const ext = p.toLowerCase().match(IMAGE_EXT_RE)?.[1]
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  return null
}
export function readImageFile(p: string): { base64: string; mime: string } | null {
  const mime = mimeForPath(p)
  if (!mime) return null
  try {
    const st = fs.statSync(p)
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return null
    return { base64: fs.readFileSync(p).toString('base64'), mime }
  } catch { return null }
}
/** mac：用 osascript 把剪贴板 PNG 写临时文件再读。非 mac / 无图 → null。 */
export function readClipboardImage(): { base64: string; mime: string } | null {
  if (process.platform !== 'darwin') return null
  const tmp = path.join(os.tmpdir(), `dc-clip-${process.pid}.png`)
  try {
    execFileSync('osascript', ['-e',
      `set png to (the clipboard as «class PNGf»)`,
      '-e', `set fp to open for access POSIX file "${tmp}" with write permission`,
      '-e', `write png to fp`, '-e', `close access fp`,
    ], { stdio: ['ignore', 'ignore', 'ignore'] })
    const r = readImageFile(tmp)
    return r
  } catch { return null } finally { try { fs.unlinkSync(tmp) } catch { /* 忽略 */ } }
}
