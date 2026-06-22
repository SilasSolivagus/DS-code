// src/notebook.ts
// Jupyter notebook (.ipynb) 解析 / 序列化 / cell 操作 / Read 格式化（纯 JSON，不执行 kernel）。

export interface NotebookOutput {
  output_type: string
  text?: string | string[]
  data?: Record<string, unknown>
  ename?: string
  evalue?: string
  traceback?: string[]
}

export interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw'
  source: string | string[]
  id?: string
  execution_count?: number | null
  outputs?: NotebookOutput[]
  metadata?: Record<string, unknown>
}

export interface NotebookContent {
  cells: NotebookCell[]
  metadata?: { language_info?: { name?: string } } & Record<string, unknown>
  nbformat?: number
  nbformat_minor?: number
}

/** 解析 .ipynb 文本；非法 JSON 或非 notebook 结构（无 cells 数组）→ null。 */
export function parseNotebook(content: string): NotebookContent | null {
  try {
    const obj = JSON.parse(content)
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && Array.isArray(obj.cells)) {
      return obj as NotebookContent
    }
    return null
  } catch {
    return null
  }
}

/** 写回 .ipynb：对齐 CC，indent=1。 */
export function serializeNotebook(nb: NotebookContent): string {
  return JSON.stringify(nb, null, 1)
}

/** 生成新 cell 的随机 id。 */
export function generateCellId(): string {
  return Math.random().toString(16).slice(2, 10)
}

/** 解析 cell_id：先按 cell.id，再解析 cell-N（越界 → -1），否则 -1。 */
export function resolveCellIndex(nb: NotebookContent, cellId: string): number {
  const byId = nb.cells.findIndex(c => c.id === cellId)
  if (byId !== -1) return byId
  const m = cellId.match(/^cell-(\d+)$/)
  if (m) {
    const i = parseInt(m[1], 10)
    if (i >= 0 && i < nb.cells.length) return i
  }
  return -1
}

export interface CellEditArgs {
  cellId: string
  newSource: string
  cellType?: 'code' | 'markdown'
  editMode: 'replace' | 'insert' | 'delete'
}

/** 就地修改 nb：replace/insert/delete。insert 必须 cellType，在 cellId 之后插入；replace/insert 的 code cell 清空 execution_count/outputs。 */
export function applyCellEdit(
  nb: NotebookContent,
  args: CellEditArgs,
): { ok: true } | { ok: false; error: string } {
  const { cellId, newSource, cellType, editMode } = args
  if (editMode === 'insert') {
    if (!cellType) return { ok: false, error: '错误：insert 模式必须指定 cell_type。' }
    const idx = resolveCellIndex(nb, cellId)
    if (idx === -1) return { ok: false, error: `错误：找不到 cell ${cellId}。` }
    const newCell: NotebookCell = { cell_type: cellType, source: newSource, id: generateCellId(), metadata: {} }
    if (cellType === 'code') { newCell.execution_count = null; newCell.outputs = [] }
    nb.cells.splice(idx + 1, 0, newCell)
    return { ok: true }
  }
  const idx = resolveCellIndex(nb, cellId)
  if (idx === -1) return { ok: false, error: `错误：找不到 cell ${cellId}。` }
  if (editMode === 'delete') {
    nb.cells.splice(idx, 1)
    return { ok: true }
  }
  // replace
  const cell = nb.cells[idx]
  cell.source = newSource
  if (cellType) cell.cell_type = cellType
  if (cell.cell_type === 'code') { cell.execution_count = null; cell.outputs = [] }
  return { ok: true }
}
