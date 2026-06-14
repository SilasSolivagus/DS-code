// src/checkpoint.ts
// CC 式 before-image 文件备份：Edit/Write 前把文件原内容（或"不存在"墓碑）按 turnId 存盘。
// /rewind 据此把文件还原到某轮开始时的状态。落盘 index.jsonl + 内容寻址 blob，cap 上限 FIFO 淘汰。
// 纯逻辑（fs 直用），无 React/ink 依赖。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

interface Entry { turn: number; path: string; kind: 'content' | 'absent'; blob?: string }

export interface RestoreResult { restored: string[]; deleted: string[]; failed: string[] }

export interface Checkpointer {
  capture(absPath: string, turn: number): void
  restoreFiles(toTurn: number): RestoreResult
  fileCountAt(turn: number): number
}

export function createCheckpointer(storeDir: string, cap = 100): Checkpointer {
  const indexFile = path.join(storeDir, 'index.jsonl')
  const blobDir = path.join(storeDir, 'blobs')
  let entries: Entry[] = []

  try {
    for (const line of fs.readFileSync(indexFile, 'utf8').split('\n')) {
      if (!line) continue
      try { entries.push(JSON.parse(line)) } catch { /* 跳过损坏行 */ }
    }
  } catch { /* 首次，无 index */ }

  const persist = () => {
    fs.mkdirSync(storeDir, { recursive: true })
    fs.writeFileSync(indexFile, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''))
  }

  const enforceCap = () => {
    if (entries.length <= cap) return
    const dropped = entries.splice(0, entries.length - cap)
    const live = new Set(entries.filter(e => e.blob).map(e => e.blob!))
    for (const e of dropped) {
      if (e.blob && !live.has(e.blob)) {
        try { fs.rmSync(path.join(blobDir, e.blob)) } catch { /* 已不在 */ }
      }
    }
  }

  return {
    capture(absPath, turn) {
      if (entries.some(e => e.turn === turn && e.path === absPath)) return
      let entry: Entry
      if (fs.existsSync(absPath)) {
        const buf = fs.readFileSync(absPath)
        const hash = crypto.createHash('sha1').update(buf).digest('hex')
        fs.mkdirSync(blobDir, { recursive: true })
        const blobPath = path.join(blobDir, hash)
        if (!fs.existsSync(blobPath)) fs.writeFileSync(blobPath, buf)
        entry = { turn, path: absPath, kind: 'content', blob: hash }
      } else {
        entry = { turn, path: absPath, kind: 'absent' }
      }
      entries.push(entry)
      enforceCap()
      persist()
    },

    restoreFiles(toTurn) {
      const result: RestoreResult = { restored: [], deleted: [], failed: [] }
      const byPath = new Map<string, Entry>()
      for (const e of entries) {
        if (e.turn < toTurn) continue
        const cur = byPath.get(e.path)
        if (!cur || e.turn < cur.turn) byPath.set(e.path, e)
      }
      for (const e of byPath.values()) {
        try {
          if (e.kind === 'absent') {
            if (fs.existsSync(e.path)) { fs.rmSync(e.path); result.deleted.push(e.path) }
          } else {
            const buf = fs.readFileSync(path.join(blobDir, e.blob!))
            fs.mkdirSync(path.dirname(e.path), { recursive: true })
            fs.writeFileSync(e.path, buf)
            result.restored.push(e.path)
          }
        } catch { result.failed.push(e.path) }
      }
      return result
    },

    fileCountAt(turn) {
      const paths = new Set<string>()
      for (const e of entries) if (e.turn === turn) paths.add(e.path)
      return paths.size
    },
  }
}
