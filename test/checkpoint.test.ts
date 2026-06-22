import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCheckpointer } from '../src/checkpoint.js'

let store: string, work: string
beforeEach(() => {
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-ckpt-'))
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-work-'))
})
afterEach(() => {
  fs.rmSync(store, { recursive: true, force: true })
  fs.rmSync(work, { recursive: true, force: true })
})
const f = (name: string) => path.join(work, name)

describe('Checkpointer', () => {
  it('capture 当轮去重：同 (turn,path) 只存首次（本轮开始内容）', () => {
    const cp = createCheckpointer(store)
    fs.writeFileSync(f('a.txt'), 'v1')
    cp.capture(f('a.txt'), 1)
    fs.writeFileSync(f('a.txt'), 'v2')
    cp.capture(f('a.txt'), 1)
    cp.restoreFiles(1)
    expect(fs.readFileSync(f('a.txt'), 'utf8')).toBe('v1')
  })

  it('restoreFiles 取"最早 ≥ T"快照', () => {
    const cp = createCheckpointer(store)
    fs.writeFileSync(f('a.txt'), 'turn1-start')
    cp.capture(f('a.txt'), 1)
    fs.writeFileSync(f('a.txt'), 'turn3-start')
    cp.capture(f('a.txt'), 3)
    fs.writeFileSync(f('a.txt'), 'latest')
    cp.restoreFiles(2)
    expect(fs.readFileSync(f('a.txt'), 'utf8')).toBe('turn3-start')
  })

  it('墓碑：本轮新建的文件，还原时删除', () => {
    const cp = createCheckpointer(store)
    cp.capture(f('new.txt'), 2)
    fs.writeFileSync(f('new.txt'), 'created')
    cp.restoreFiles(2)
    expect(fs.existsSync(f('new.txt'))).toBe(false)
  })

  it('turn >= T 无快照的文件不动', () => {
    const cp = createCheckpointer(store)
    fs.writeFileSync(f('a.txt'), 'a-orig')
    cp.capture(f('a.txt'), 1)
    fs.writeFileSync(f('b.txt'), 'b-untouched')
    cp.restoreFiles(1)
    expect(fs.readFileSync(f('b.txt'), 'utf8')).toBe('b-untouched')
  })

  it('restore-only-if-differs：当前内容已等于目标 before-image → 跳过写入、不计入 restored、不 bump mtime', () => {
    const cp = createCheckpointer(store)
    fs.writeFileSync(f('a.txt'), 'same'); cp.capture(f('a.txt'), 1)
    // 当前内容仍等于 before-image（模型没改或改回了）
    const beforeMtime = fs.statSync(f('a.txt')).mtimeMs
    const r = cp.restoreFiles(1)
    expect(r.restored).not.toContain(f('a.txt'))            // 无谓写入被跳过
    expect(fs.statSync(f('a.txt')).mtimeMs).toBe(beforeMtime) // mtime 未变（没触发 watcher）
  })

  it('restore-only-if-differs：当前内容与目标不同 → 正常还原并计入 restored', () => {
    const cp = createCheckpointer(store)
    fs.writeFileSync(f('a.txt'), 'orig'); cp.capture(f('a.txt'), 1)
    fs.writeFileSync(f('a.txt'), 'changed')
    const r = cp.restoreFiles(1)
    expect(r.restored).toContain(f('a.txt'))
    expect(fs.readFileSync(f('a.txt'), 'utf8')).toBe('orig')
  })

  it('fileCountAt：某轮捕获的不同 path 数', () => {
    const cp = createCheckpointer(store)
    fs.writeFileSync(f('a.txt'), 'a'); cp.capture(f('a.txt'), 5)
    fs.writeFileSync(f('b.txt'), 'b'); cp.capture(f('b.txt'), 5)
    cp.capture(f('a.txt'), 5)
    expect(cp.fileCountAt(5)).toBe(2)
    expect(cp.fileCountAt(9)).toBe(0)
  })

  it('落盘 + 重载：新实例从 index 复原可还原', () => {
    const cp1 = createCheckpointer(store)
    fs.writeFileSync(f('a.txt'), 'persisted-v1')
    cp1.capture(f('a.txt'), 1)
    fs.writeFileSync(f('a.txt'), 'changed')
    const cp2 = createCheckpointer(store)
    cp2.restoreFiles(1)
    expect(fs.readFileSync(f('a.txt'), 'utf8')).toBe('persisted-v1')
  })

  it('cap：超上限 FIFO 淘汰最旧条目', () => {
    const cp = createCheckpointer(store, 2)
    fs.writeFileSync(f('a.txt'), 'a'); cp.capture(f('a.txt'), 1)
    fs.writeFileSync(f('b.txt'), 'b'); cp.capture(f('b.txt'), 2)
    fs.writeFileSync(f('c.txt'), 'c'); cp.capture(f('c.txt'), 3)
    fs.writeFileSync(f('a.txt'), 'a-new')
    cp.restoreFiles(1)
    expect(fs.readFileSync(f('a.txt'), 'utf8')).toBe('a-new')
    fs.writeFileSync(f('c.txt'), 'c-changed')
    cp.restoreFiles(3)
    expect(fs.readFileSync(f('c.txt'), 'utf8')).toBe('c')
  })
})
