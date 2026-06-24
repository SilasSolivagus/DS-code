import { describe, it, expect, vi } from 'vitest'

// Hermetic: mock node:os homedir to temp dir before any config import.
// Follows the same pattern as test/config.test.ts to avoid writing to real ~/.deepcode.
vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>()
  const { mkdtempSync } = await import('node:fs')
  const path = await import('node:path')
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'dc-theme-conf-'))
  const homedir = () => fakeHome
  return { ...os, homedir, default: { ...os, homedir } }
})

import { loadSettings } from '../src/config.js'

describe('theme config', () => {
  it('缺省时 theme 为 undefined（运行期默认 dark 在 Provider 兜底）', () => {
    expect(loadSettings().theme).toBeUndefined()
  })
})
