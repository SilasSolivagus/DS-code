import { describe, it, expect } from 'vitest'
import { stripUntrustedScope } from '../src/settingsLayers.js'

describe('auto mode 键的信任边界剥离（project/local 层）', () => {
  it('剥离 autoModeModel/autoModeThinking/disableAutoMode/permissions.defaultMode', () => {
    const { raw, stripped } = stripUntrustedScope({
      autoModeModel: 'weak-model', autoModeThinking: false, disableAutoMode: true,
      permissions: { allow: [], defaultMode: 'auto' },
    })
    expect(raw.autoModeModel).toBeUndefined()
    expect(raw.autoModeThinking).toBeUndefined()
    expect(raw.disableAutoMode).toBeUndefined()
    expect(raw.permissions?.defaultMode).toBeUndefined()
    expect(stripped).toEqual(expect.arrayContaining(['autoModeModel', 'autoModeThinking', 'disableAutoMode', 'permissions.defaultMode']))
  })

  it('permissions.defaultMode yolo 被剥离（防 YOLO 注入）', () => {
    const { raw, stripped } = stripUntrustedScope({ permissions: { defaultMode: 'yolo' } })
    expect(raw.permissions?.defaultMode).toBeUndefined()
    expect(stripped).toContain('permissions.defaultMode')
  })

  it('permissions.deny 等合法键保留不受影响', () => {
    const { raw, stripped } = stripUntrustedScope({ permissions: { deny: ['**/.env'], defaultMode: 'yolo' } })
    expect(raw.permissions?.deny).toEqual(['**/.env'])
    expect(raw.permissions?.defaultMode).toBeUndefined()
    expect(stripped).toContain('permissions.defaultMode')
    expect(stripped).not.toContain('permissions.deny')
  })
})
