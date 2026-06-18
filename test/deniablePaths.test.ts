import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { readTool } from '../src/tools/read.js'
import { editTool } from '../src/tools/edit.js'
import { writeTool } from '../src/tools/write.js'
import { bashTool } from '../src/tools/bash.js'

const home = os.homedir()
describe('deniablePaths', () => {
  it('Read 返回 resolve 后的 file_path', () => {
    expect(readTool.deniablePaths!({ file_path: 'a/b.ts' }, '/proj')).toEqual(['/proj/a/b.ts'])
  })
  it('Edit/Write 同理', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(editTool.deniablePaths!({ file_path: '/abs/x', old_string: '', new_string: '' } as any, '/proj')).toEqual(['/abs/x'])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(writeTool.deniablePaths!({ file_path: 'rel', content: '' } as any, '/proj')).toEqual(['/proj/rel'])
  })
  it('Bash 挑路径样 token，~ 展开', () => {
    const out = bashTool.deniablePaths!({ command: 'cat ~/.ssh/id_rsa && echo hi' }, '/proj')
    expect(out).toContain(path.join(home, '.ssh/id_rsa'))
    expect(out).not.toContain('echo')
  })
})
