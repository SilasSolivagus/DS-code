import { describe, it, expect } from 'vitest'
import { GUTTER, BLOCK_GAP } from '../src/tui/theme.js'

describe('间距常量', () => {
  it('GUTTER=1 BLOCK_GAP=1', () => {
    expect(GUTTER).toBe(1)
    expect(BLOCK_GAP).toBe(1)
  })
})
