import { describe, it, expect } from 'vitest'
import { TaskListStore } from '../src/taskList.js'

describe('TaskListStore CRUD（内存）', () => {
  it('create 分配单调 id，默认 pending', () => {
    const s = new TaskListStore()
    const a = s.create({ subject: '甲', description: '做甲' })
    const b = s.create({ subject: '乙', description: '做乙' })
    expect(a.id).toBe('1')
    expect(b.id).toBe('2')
    expect(a.status).toBe('pending')
  })
  it('get 取全字段；不存在返回 undefined', () => {
    const s = new TaskListStore()
    const a = s.create({ subject: '甲', description: '做甲', activeForm: '做甲中', metadata: { k: 1 } })
    expect(s.get('1')).toMatchObject({ id: '1', subject: '甲', description: '做甲', activeForm: '做甲中', metadata: { k: 1 } })
    expect(s.get('99')).toBeUndefined()
  })
  it('update 改字段、状态转移、返回改动字段名', () => {
    const s = new TaskListStore()
    s.create({ subject: '甲', description: '做甲' })
    const r = s.update('1', { status: 'in_progress', subject: '甲改' })
    expect(r.ok).toBe(true)
    expect(r.updatedFields.sort()).toEqual(['status', 'subject'])
    expect(s.get('1')!.status).toBe('in_progress')
    expect(s.get('1')!.subject).toBe('甲改')
  })
  it('update 不存在的任务 → ok:false', () => {
    const s = new TaskListStore()
    expect(s.update('1', { status: 'completed' })).toEqual({ ok: false, updatedFields: [] })
  })
  it('metadata 合并：值 null 删键', () => {
    const s = new TaskListStore()
    s.create({ subject: '甲', description: 'd', metadata: { a: 1, b: 2 } })
    s.update('1', { metadata: { b: null, c: 3 } })
    expect(s.get('1')!.metadata).toEqual({ a: 1, c: 3 })
  })
  it('软删除：status deleted 后 list 不含、get 仍可取', () => {
    const s = new TaskListStore()
    s.create({ subject: '甲', description: 'd' })
    s.create({ subject: '乙', description: 'd' })
    s.update('1', { status: 'deleted' })
    expect(s.list().map(t => t.id)).toEqual(['2'])
    expect(s.get('1')).toBeDefined()              // 软删后仍可查
    expect(s.get('1')!.status).toBe('pending')    // 软删只置 _deleted，status 保持原值不被污染
  })
  it('list 排除 metadata._internal===true', () => {
    const s = new TaskListStore()
    s.create({ subject: '正常', description: 'd' })
    s.create({ subject: '内部', description: 'd', metadata: { _internal: true } })
    expect(s.list().map(t => t.subject)).toEqual(['正常'])
  })
  it('remove 硬删除：list 与 get 都没了', () => {
    const s = new TaskListStore()
    s.create({ subject: '甲', description: 'd' })
    s.remove('1')
    expect(s.get('1')).toBeUndefined()
    expect(s.list()).toEqual([])
  })
})
