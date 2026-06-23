// test/workspace.tools.test.ts
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { writeTool } from '../src/tools/write.js'
import { readTool } from '../src/tools/read.js'
import { globTool } from '../src/tools/glob.js'

describe('workspacePaths', () => {
  it('Write 返回解析后的 file_path', () => {
    expect(writeTool.workspacePaths!({ file_path: 'a.txt', content: '' }, '/proj')).toEqual([path.resolve('/proj', 'a.txt')])
  })
  it('Read 返回解析后的 file_path', () => {
    expect(readTool.workspacePaths!({ file_path: 'b.ts' }, '/proj')).toEqual([path.resolve('/proj', 'b.ts')])
  })
  it('Glob 返回搜索根（默认 cwd）', () => {
    expect(globTool.workspacePaths!({ pattern: '**/*.ts' }, '/proj')).toEqual([path.resolve('/proj')])
  })
  it('Glob 返回搜索根（指定 path）', () => {
    expect(globTool.workspacePaths!({ pattern: '*', path: 'sub' }, '/proj')).toEqual([path.resolve('/proj', 'sub')])
  })
})
