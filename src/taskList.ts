// src/taskList.ts —— CC 式 todo Task 模型 + store（内存 CRUD + 软删 + metadata + 走神 + 落盘）。
export interface Task {
  id: string
  subject: string
  description: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
  metadata?: Record<string, unknown>
}

/** 内部存储形态：Task + 软删标记（不对外暴露 _deleted）。 */
type StoredTask = Task & { _deleted?: boolean }

export class TaskListStore {
  private tasks = new Map<string, StoredTask>()
  private nextId = 1
  private lastUpdateTurn = 0
  private currentTurn = 0

  private toPublic(t: StoredTask): Task {
    const { _deleted, ...pub } = t
    return pub
  }

  create(input: { subject: string; description: string; activeForm?: string; metadata?: Record<string, unknown> }): Task {
    const id = String(this.nextId++)
    const t: StoredTask = {
      id, subject: input.subject, description: input.description, status: 'pending',
      ...(input.activeForm !== undefined ? { activeForm: input.activeForm } : {}),
      ...(input.metadata !== undefined ? { metadata: { ...input.metadata } } : {}),
    }
    this.tasks.set(id, t)
    this.lastUpdateTurn = this.currentTurn
    return this.toPublic(t)
  }

  get(id: string): Task | undefined {
    const t = this.tasks.get(id)
    return t ? this.toPublic(t) : undefined
  }

  update(id: string, patch: { subject?: string; description?: string; activeForm?: string; status?: 'pending' | 'in_progress' | 'completed' | 'deleted'; metadata?: Record<string, unknown> }): { ok: boolean; updatedFields: string[] } {
    const t = this.tasks.get(id)
    if (!t) return { ok: false, updatedFields: [] }
    const updated: string[] = []
    if (patch.subject !== undefined) { t.subject = patch.subject; updated.push('subject') }
    if (patch.description !== undefined) { t.description = patch.description; updated.push('description') }
    if (patch.activeForm !== undefined) { t.activeForm = patch.activeForm; updated.push('activeForm') }
    if (patch.metadata !== undefined) {
      const m = { ...(t.metadata ?? {}) }
      for (const [k, v] of Object.entries(patch.metadata)) {
        if (v === null) delete m[k]
        else m[k] = v
      }
      t.metadata = m
      updated.push('metadata')
    }
    if (patch.status !== undefined) {
      if (patch.status === 'deleted') { t._deleted = true }
      else { t.status = patch.status }
      updated.push('status')
    }
    this.lastUpdateTurn = this.currentTurn
    return { ok: true, updatedFields: updated }
  }

  /** 列出活跃任务：排除软删与 metadata._internal===true。 */
  list(): Task[] {
    return [...this.tasks.values()]
      .filter(t => !t._deleted && t.metadata?._internal !== true)
      .map(t => this.toPublic(t))
  }

  /** 硬删除（用于 blocked-create 回滚）。 */
  remove(id: string): void {
    this.tasks.delete(id)
  }
}
