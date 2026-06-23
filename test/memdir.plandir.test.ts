import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { planDirFor } from '../src/memdir/paths.js'

describe('planDirFor', () => {
  it('非 git 目录用 cwd 键 + plans 子目录', () => {
    const d = planDirFor('/tmp/nogit-xyz', '/home/u')
    expect(d).toBe(path.join('/home/u', '.deepcode', 'projects', '-tmp-nogit-xyz', 'plans'))
  })
})
