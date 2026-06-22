// src/steering.ts —— 会话级 steering 队列：用户中途插入消息的 FIFO 缓冲。
// priority 仅用于 TUI 列队展示 + now/next/later 枚举保留供 SDK/未来用途；不影响 drain（用户路径恒 next，软中断由 useChat toolInFlight 决定）。
// deepcode 无 Sleep 工具，无 later-only 边界，故 drain 一律 drainAll（对齐 spec §6「later 暂同 next」）。

export type SteeringPriority = 'now' | 'next' | 'later'

export interface SteeringItem {
  id: string
  value: string
  priority: SteeringPriority
}

export function formatSteeringMessage(value: string): string {
  return `<queued-user-message>\n用户在你执行过程中补充了这条消息（在你看到它之前已发出）。请据此调整当前工作：\n${value}\n</queued-user-message>`
}

export class SteeringQueue {
  #items: SteeringItem[] = []
  #nextId = 1
  #subs = new Set<() => void>()

  get size(): number { return this.#items.length }

  enqueue(value: string, priority: SteeringPriority): SteeringItem {
    const item: SteeringItem = { id: `steer-${this.#nextId++}`, value, priority }
    this.#items.push(item)
    this.#notify()
    return item
  }

  drainAll(): SteeringItem[] {
    if (this.#items.length === 0) return []
    const out = this.#items
    this.#items = []
    this.#notify()
    return out
  }

  popLast(): SteeringItem | undefined {
    const item = this.#items.pop()
    if (item) this.#notify()
    return item
  }

  peek(): readonly SteeringItem[] { return this.#items }

  clear(): void {
    if (this.#items.length === 0) return
    this.#items = []
    this.#notify()
  }

  subscribe(fn: () => void): () => void {
    this.#subs.add(fn)
    return () => { this.#subs.delete(fn) }
  }

  #notify(): void { for (const fn of this.#subs) fn() }
}
