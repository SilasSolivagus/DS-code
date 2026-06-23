import { describe, it, expect } from 'vitest'
import { THEMES, DEFAULT_THEME, themeNames } from '../src/tui/theme.js'

const KEYS = ['accent', 'reasoning', 'ok', 'err', 'warn', 'dim'] as const

describe('themes 六套', () => {
  it('恰好六套，名字齐全', () => {
    expect(themeNames().sort()).toEqual(
      ['dark', 'dark-ansi', 'dark-daltonized', 'light', 'light-ansi', 'light-daltonized'].sort()
    )
  })
  it('每套含全部颜色键且非空', () => {
    for (const name of themeNames()) {
      for (const k of KEYS) {
        expect(THEMES[name][k], `${name}.${k}`).toBeTruthy()
      }
    }
  })
  it('ansi 套用 ANSI 安全色名（无 # truecolor）', () => {
    for (const name of ['dark-ansi', 'light-ansi']) {
      for (const k of KEYS) {
        expect(THEMES[name][k].startsWith('#'), `${name}.${k} 不应是 hex`).toBe(false)
      }
    }
  })
  it('DEFAULT_THEME === THEMES.dark', () => {
    expect(DEFAULT_THEME).toBe(THEMES.dark)
  })
})
