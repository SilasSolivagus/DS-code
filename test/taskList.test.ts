import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

describe('TaskListStore 走神检测', () => {
  it('有未完成项且 3 轮未更新 → 返回提醒', () => {
    const s = new TaskListStore()
    s.create({ subject: '甲', description: 'd' })  // lastUpdateTurn=0
    s.tick(); s.tick(); s.tick()                    // currentTurn=3，delta=3
    const note = s.staleReminder()
    expect(note).toContain('#1 甲')
    expect(note).toContain('3 轮未更新')
  })
  it('未到 3 轮 → null', () => {
    const s = new TaskListStore()
    s.create({ subject: '甲', description: 'd' })
    s.tick(); s.tick()                              // delta=2
    expect(s.staleReminder()).toBeNull()
  })
  it('全部 completed → null', () => {
    const s = new TaskListStore()
    s.create({ subject: '甲', description: 'd' })
    s.update('1', { status: 'completed' })
    s.tick(); s.tick(); s.tick()
    expect(s.staleReminder()).toBeNull()
  })
  it('update 重置 delta（lastUpdateTurn 跟到 currentTurn）', () => {
    const s = new TaskListStore()
    s.create({ subject: '甲', description: 'd' })
    s.tick(); s.tick()
    s.update('1', { status: 'in_progress' })        // lastUpdateTurn=currentTurn(=2)
    s.tick(); s.tick()                              // delta=2
    expect(s.staleReminder()).toBeNull()
    s.tick()                                        // delta=3
    expect(s.staleReminder()).toContain('#1 甲')
  })
  it('activeForm 显示在提醒里', () => {
    const s = new TaskListStore()
    s.create({ subject: '甲', description: 'd', activeForm: '跑测试' })
    s.tick(); s.tick(); s.tick()
    expect(s.staleReminder()).toContain('（跑测试）')
  })
})

describe('TaskListStore 落盘 + bind', () => {
  function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dc-tl-')) }

  it('create 后磁盘有 <id>.json；bind 新 store 能加载回来', () => {
    const base = tmp(); const sid = 'sess1'
    const s1 = new TaskListStore(); s1.bind(sid, base)
    s1.create({ subject: '甲', description: '做甲' })
    expect(fs.existsSync(path.join(base, sid, '1.json'))).toBe(true)
    const s2 = new TaskListStore(); s2.bind(sid, base)
    expect(s2.get('1')).toMatchObject({ subject: '甲', description: '做甲' })
  })

  it('nextId = max(已加载 id)+1，防覆写', () => {
    const base = tmp(); const sid = 'sess2'
    const s1 = new TaskListStore(); s1.bind(sid, base)
    s1.create({ subject: 'a', description: 'd' }) // id 1
    s1.create({ subject: 'b', description: 'd' }) // id 2
    const s2 = new TaskListStore(); s2.bind(sid, base)
    const c = s2.create({ subject: 'c', description: 'd' })
    expect(c.id).toBe('3')                                   // 不复用 1/2
    expect(s2.get('1')).toMatchObject({ subject: 'a' })      // 旧任务未被覆写
  })

  it('坏 JSON 文件静默跳过，不崩', () => {
    const base = tmp(); const sid = 'sess3'
    fs.mkdirSync(path.join(base, sid), { recursive: true })
    fs.writeFileSync(path.join(base, sid, '1.json'), '{坏 json')
    fs.writeFileSync(path.join(base, sid, '2.json'), JSON.stringify({ id: '2', subject: '好', description: 'd', status: 'pending' }))
    const s = new TaskListStore(); s.bind(sid, base)
    expect(s.get('2')).toMatchObject({ subject: '好' })
    expect(s.get('1')).toBeUndefined()
  })

  it('软删除落盘 deleted:true；reload 后 list 不含、get 仍在', () => {
    const base = tmp(); const sid = 'sess4'
    const s1 = new TaskListStore(); s1.bind(sid, base)
    s1.create({ subject: 'a', description: 'd' })
    s1.update('1', { status: 'deleted' })
    const s2 = new TaskListStore(); s2.bind(sid, base)
    expect(s2.list()).toEqual([])
    expect(s2.get('1')).toBeDefined()
  })

  it('bind 清零走神计数器（resume 不瞬间刷屏）', () => {
    const base = tmp(); const sid = 'sess5'
    const s1 = new TaskListStore(); s1.bind(sid, base)
    s1.create({ subject: 'a', description: 'd' })
    const s2 = new TaskListStore(); s2.bind(sid, base)   // reload 有 1 个未完成项
    expect(s2.staleReminder()).toBeNull()               // 计数器从 0，delta=0
    s2.tick(); s2.tick(); s2.tick()
    expect(s2.staleReminder()).toContain('#1 a')         // 正常 3 轮后才提醒
  })

  it('原子写：未出现 .tmp 残留', () => {
    const base = tmp(); const sid = 'sess6'
    const s = new TaskListStore(); s.bind(sid, base)
    s.create({ subject: 'a', description: 'd' })
    const files = fs.readdirSync(path.join(base, sid))
    expect(files.some(f => f.endsWith('.tmp'))).toBe(false)
    expect(files).toContain('1.json')
  })
})

describe('1.6 任务依赖图', () => {
  it('addBlockedBy 加依赖，未完成依赖时拦截 in_progress', () => {
    const s = new TaskListStore()
    const a = s.create({ subject: 'A', description: 'dep' })
    const b = s.create({ subject: 'B', description: 'main' })
    s.update(b.id, { addBlockedBy: [a.id] })
    const blocked = s.update(b.id, { status: 'in_progress' })
    expect(blocked.ok).toBe(false)
    expect(blocked.blockedByOpen).toEqual([a.id])
    expect(s.get(b.id)!.status).toBe('pending') // 未变
  })

  it('依赖完成后可转 in_progress', () => {
    const s = new TaskListStore()
    const a = s.create({ subject: 'A', description: 'dep' })
    const b = s.create({ subject: 'B', description: 'main' })
    s.update(b.id, { addBlockedBy: [a.id] })
    s.update(a.id, { status: 'completed' })
    const ok = s.update(b.id, { status: 'in_progress' })
    expect(ok.ok).toBe(true)
    expect(s.get(b.id)!.status).toBe('in_progress')
  })

  it('软删的依赖视同已清，不永久卡死后继', () => {
    const s = new TaskListStore()
    const a = s.create({ subject: 'A', description: 'dep' })
    const b = s.create({ subject: 'B', description: 'main' })
    s.update(b.id, { addBlockedBy: [a.id] })
    s.update(a.id, { status: 'deleted' }) // 软删依赖
    expect(s.openBlockers(b.id)).toEqual([])
    expect(s.update(b.id, { status: 'in_progress' }).ok).toBe(true)
  })

  it('addBlocks/addBlockedBy 去重累加', () => {
    const s = new TaskListStore()
    const t = s.create({ subject: 'T', description: 'x' })
    s.update(t.id, { addBlockedBy: ['9', '9'] })
    s.update(t.id, { addBlockedBy: ['9', '8'] })
    expect(s.get(t.id)!.blockedBy).toEqual(['9', '8'])
    s.update(t.id, { addBlocks: ['5'] })
    expect(s.get(t.id)!.blocks).toEqual(['5'])
  })
})
