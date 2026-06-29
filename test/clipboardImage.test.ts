import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { IMAGE_EXT_RE, mimeForPath, readImageFile } from '../src/clipboardImage.js'

describe('clipboardImage', () => {
  it('IMAGE_EXT_RE / mimeForPath', () => {
    expect(IMAGE_EXT_RE.test('a.png')).toBe(true); expect(IMAGE_EXT_RE.test('a.gif')).toBe(false)
    expect(mimeForPath('x.jpeg')).toBe('image/jpeg'); expect(mimeForPath('x.txt')).toBeNull()
  })
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-img-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
  it('readImageFile：小 PNG 读出 base64', () => {
    const f = path.join(dir, 'a.png'); fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const r = readImageFile(f)!; expect(r.mime).toBe('image/png'); expect(r.base64).toBe('iVBORw==')
  })
  it('readImageFile：非图/不存在→null', () => {
    expect(readImageFile(path.join(dir, 'a.txt'))).toBeNull()
    expect(readImageFile(path.join(dir, 'nope.png'))).toBeNull()
  })
})
