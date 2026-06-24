// src/taskList.ts —— CC 式 todo Task 模型 + store（内存 CRUD + 软删 + metadata + 走神 + 落盘）。
import fs from 'node:fs'
import path from 'node:path'
import { TASK_LISTS_DIR } from './config.js'

export interface Task {
  id: string
  subject: string
  description: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
  metadata?: Record<string, unknown>
  blocks?: string[]
  blockedBy?: string[]
}

/** 内部存储形态：Task + 软删标记（不对外暴露 _deleted）。 */
type StoredTask = Task & { _deleted?: boolean }

export class TaskListStore {
  private tasks = new Map<string, StoredTask>()
  private nextId = 1
  private lastUpdateTurn = 0
  private currentTurn = 0
  private dir?: string

  private toPublic(t: StoredTask): Task {
    const { _deleted, ...pub } = t
    return pub
  }

  /** blockedBy 中既未 completed 也未软删的依赖 id（软删依赖视同已清，避免删依赖永久卡死后继）。 */
  openBlockers(id: string): string[] {
    const t = this.tasks.get(id)
    if (!t?.blockedBy?.length) return []
    return t.blockedBy.filter(dep => {
      const d = this.tasks.get(dep)
      if (!d) return false           // 依赖不存在 → 视同已清
      if (d._deleted) return false   // 软删 → 视同已清
      return d.status !== 'completed'
    })
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
    this.persist(id)
    return this.toPublic(t)
  }

  get(id: string): Task | undefined {
    const t = this.tasks.get(id)
    return t ? this.toPublic(t) : undefined
  }

  update(id: string, patch: { subject?: string; description?: string; activeForm?: string; status?: 'pending' | 'in_progress' | 'completed' | 'deleted'; metadata?: Record<string, unknown>; addBlocks?: string[]; addBlockedBy?: string[] }): { ok: boolean; updatedFields: string[]; blockedByOpen?: string[] } {
    const t = this.tasks.get(id)
    if (!t) return { ok: false, updatedFields: [] }
    // 依赖门控：转 in_progress 前校验 blockedBy 全清（completed/软删/不存在）
    if (patch.status === 'in_progress') {
      const open = this.openBlockers(id)
      if (open.length) return { ok: false, updatedFields: [], blockedByOpen: open }
    }
    const updated: string[] = []
    if (patch.subject !== undefined) { t.subject = patch.subject; updated.push('subject') }
    if (patch.description !== undefined) { t.description = patch.description; updated.push('description') }
    if (patch.activeForm !== undefined) { t.activeForm = patch.activeForm; updated.push('activeForm') }
    if (patch.addBlocks?.length) { t.blocks = [...new Set([...(t.blocks ?? []), ...patch.addBlocks])]; updated.push('blocks') }
    if (patch.addBlockedBy?.length) { t.blockedBy = [...new Set([...(t.blockedBy ?? []), ...patch.addBlockedBy])]; updated.push('blockedBy') }
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
    this.persist(id)
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
    if (this.dir) { try { fs.unlinkSync(path.join(this.dir, `${id}.json`)) } catch { /* 已不在 */ } }
  }

  /** 每个含工具调用的 loop turn 由调用方推进一次。 */
  tick(): void { this.currentTurn++ }

  /** 到提醒节奏（每 3 轮一次、有未完成项）则返回提醒文本，否则 null。 */
  staleReminder(): string | null {
    const open = this.list().filter(t => t.status !== 'completed')
    const delta = this.currentTurn - this.lastUpdateTurn
    if (!open.length || delta < 3 || delta % 3 !== 0) return null
    return `任务清单已 ${delta} 轮未更新。未完成项：\n` +
      open.map(t => `- [${t.status}] #${t.id} ${t.subject}${t.activeForm ? `（${t.activeForm}）` : ''}`).join('\n') +
      `\n请对照清单检查进度，完成一项就用 TaskUpdate 把它标 completed 并把下一项标 in_progress；计划变了就更新清单。`
  }

  /** (重)绑定到某 session 的磁盘目录：加载任务、seed nextId、计数器清零。
   *  baseDir 默认 TASK_LISTS_DIR（可注入便测）。startup/resume/clear 都调它。 */
  bind(sessionId: string, baseDir: string = TASK_LISTS_DIR): void {
    this.dir = path.join(baseDir, sessionId)
    this.tasks.clear()
    this.nextId = 1
    this.currentTurn = 0
    this.lastUpdateTurn = 0
    this.loadFromDisk()
  }

  private loadFromDisk(): void {
    if (!this.dir) return
    let files: string[] = []
    try { files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json')) } catch { return }
    let maxId = 0
    for (const f of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as StoredTask & { deleted?: boolean }
        if (typeof raw.id !== 'string') continue
        const t: StoredTask = { ...raw }
        if (raw.deleted) { t._deleted = true; delete (t as any).deleted }
        this.tasks.set(t.id, t)
        const n = Number(t.id)
        if (Number.isInteger(n) && n > maxId) maxId = n
      } catch { /* 坏文件跳过 */ }
    }
    this.nextId = maxId + 1
  }

  private persist(id: string): void {
    if (!this.dir) return
    const t = this.tasks.get(id)
    if (!t) return
    fs.mkdirSync(this.dir, { recursive: true })
    const { _deleted, ...rest } = t
    const onDisk = _deleted ? { ...rest, deleted: true } : rest
    const file = path.join(this.dir, `${id}.json`)
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(onDisk, null, 2))
    fs.renameSync(tmp, file)
  }
}
