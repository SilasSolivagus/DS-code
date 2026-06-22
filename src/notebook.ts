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
