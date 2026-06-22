import { describe, it, expect, vi } from 'vitest'
import { SteeringQueue, formatSteeringMessage } from '../src/steering.js'

describe('SteeringQueue', () => {
  it('enqueue 返回带唯一 id 的项并保序', () => {
    const q = new SteeringQueue()
    const a = q.enqueue('first', 'next')
    const b = q.enqueue('second', 'now')
    expect(a.id).not.toBe(b.id)
    expect(q.peek().map(i => i.value)).toEqual(['first', 'second'])
    expect(q.size).toBe(2)
  })

  it('drainAll 返回全部并清空，FIFO 保序', () => {
    const q = new SteeringQueue()
    q.enqueue('a', 'next'); q.enqueue('b', 'now'); q.enqueue('c', 'later')
    expect(q.drainAll().map(i => i.value)).toEqual(['a', 'b', 'c'])
    expect(q.size).toBe(0)
    expect(q.drainAll()).toEqual([])
  })

  it('popLast 移除并返回最后一项', () => {
    const q = new SteeringQueue()
    q.enqueue('a', 'next'); q.enqueue('b', 'next')
    expect(q.popLast()?.value).toBe('b')
    expect(q.peek().map(i => i.value)).toEqual(['a'])
    q.popLast()
    expect(q.popLast()).toBeUndefined()
  })

  it('clear 清空', () => {
    const q = new SteeringQueue()
    q.enqueue('a', 'next')
    q.clear()
    expect(q.size).toBe(0)
  })

  it('subscribe 在 enqueue/drainAll/popLast/clear 后通知，退订后不再通知', () => {
    const q = new SteeringQueue()
    const fn = vi.fn()
    const off = q.subscribe(fn)
    q.enqueue('a', 'next')
    q.drainAll()
    q.enqueue('b', 'now'); q.popLast()
    q.clear()
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(4)
    off()
    const before = fn.mock.calls.length
    q.enqueue('c', 'next')
    expect(fn.mock.calls.length).toBe(before)
  })

  it('formatSteeringMessage 包 queued-user-message 标记', () => {
    const out = formatSteeringMessage('改用 TypeScript')
    expect(out).toContain('<queued-user-message>')
    expect(out).toContain('</queued-user-message>')
    expect(out).toContain('改用 TypeScript')
  })
})
