// src/tools/notebookEdit.ts
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import type { Tool } from './types.js'
import { checkFileState } from './edit.js'
import { parseNotebook, serializeNotebook, applyCellEdit } from '../notebook.js'

const schema = z.object({
  notebook_path: z.string().describe('要编辑的 .ipynb 文件路径'),
  cell_id: z.string().describe('目标 cell 的 id（真实 id 或 cell-N 索引格式）'),
  new_source: z.string().describe('新的 cell 源码/文本（delete 时忽略）'),
  cell_type: z.enum(['code', 'markdown']).optional().describe('cell 类型；insert 模式必填'),
  edit_mode: z.enum(['replace', 'insert', 'delete']).optional().describe('编辑模式，默认 replace；insert 在 cell_id 之后插入'),
})

export const notebookEditTool: Tool<typeof schema> = {
  name: 'NotebookEdit',
  description:
    '编辑 Jupyter notebook (.ipynb) 的单个 cell：replace（替换源码，清空输出）/ insert（在指定 cell 之后插入，需 cell_type）/ delete（删除）。纯 JSON 编辑，不执行 cell。编辑前必须先用 Read 读取该 notebook。',
  inputSchema: schema,
  isReadOnly: false,
  needsPermission: input => `编辑 ${input.notebook_path}`,
  deniablePaths: (input, cwd) => [path.resolve(cwd, input.notebook_path)],
  async call(input, ctx) {
    const p = path.resolve(ctx.cwd(), input.notebook_path)
    const stateErr = checkFileState(p, ctx)
    if (stateErr) return stateErr
    const nb = parseNotebook(fs.readFileSync(p, 'utf8'))
    if (!nb) return `错误：${p} 不是合法的 Jupyter notebook（JSON 解析失败）。`
    const editMode = input.edit_mode ?? 'replace'
    const r = applyCellEdit(nb, {
      cellId: input.cell_id,
      newSource: input.new_source,
      cellType: input.cell_type,
      editMode,
    })
    if (!r.ok) return r.error
    ctx.recordBeforeImage?.(p)
    fs.writeFileSync(p, serializeNotebook(nb))
    ctx.fileState.set(p, fs.statSync(p).mtimeMs)
    return `已编辑 notebook ${p}（${editMode} cell ${input.cell_id}）。`
  },
}
