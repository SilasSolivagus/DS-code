// src/tasks.ts
import crypto from 'node:crypto'
import type { ChildProcess } from 'node:child_process'

export type TaskType = 'local_bash' | 'local_agent'
export type TaskStatus = 'running' | 'completed' | 'failed' | 'killed'

export interface BackgroundTask {
  id: string
  type: TaskType
  status: TaskStatus
  description: string
  toolUseId?: string
  startTime: number
  endTime?: number
  outputFile: string
  outputOffset: number
  notified: boolean
  // bash 专有
  command?: string
  child?: ChildProcess
  // agent 专有
  prompt?: string
  abortController?: AbortController
  result?: string
}

export interface TaskNotification {
  id: string
  status: TaskStatus
  summary: string
  result?: string
  outputFile?: string
}

// ── 注册表（模块级单例） ───────────────────────────────────────────────
const tasks = new Map<string, BackgroundTask>()

export function registerTask(t: BackgroundTask): void {
  tasks.set(t.id, t)
}

export function getTask(id: string): BackgroundTask | undefined {
  return tasks.get(id)
}

export function listTasks(): BackgroundTask[] {
  return [...tasks.values()]
}

export function updateTask(id: string, patch: Partial<BackgroundTask>): void {
  const t = tasks.get(id)
  if (!t) return
  Object.assign(t, patch)
}

export function removeTask(id: string): void {
  tasks.delete(id)
}

/** 测试用：清空注册表 */
export function clearAllTasks(): void {
  tasks.clear()
}

// ── ID 生成 ────────────────────────────────────────────────────────────
const ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz' // [0-9a-z]，36 字符

/** 前缀（bash→'b' / agent→'a'）+ 8 位 [0-9a-z]。rand 可注入以便测确定输出。 */
export function generateTaskId(type: TaskType, rand: (n: number) => Buffer = crypto.randomBytes): string {
  const prefix = type === 'local_bash' ? 'b' : 'a'
  const bytes = rand(8)
  let s = ''
  for (let i = 0; i < 8; i++) s += ID_CHARS[bytes[i] % ID_CHARS.length]
  return prefix + s
}

// ── 通知队列（模块级单例） ─────────────────────────────────────────────
const queue: TaskNotification[] = []
const subscribers = new Set<() => void>()

function toNotification(task: BackgroundTask): TaskNotification {
  const summary = task.type === 'local_agent'
    ? `子代理${statusZh(task.status)}`
    : `命令${statusZh(task.status)}`
  return {
    id: task.id,
    status: task.status,
    summary,
    result: task.type === 'local_agent' ? task.result : undefined,
    outputFile: task.type === 'local_bash' ? task.outputFile : undefined,
  }
}

function statusZh(status: TaskStatus): string {
  switch (status) {
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'killed': return '已停止'
    default: return '运行中'
  }
}

/** 完成通知入队。先 check-and-set notified（去重灵魂），已通知则跳过；再 push 并触发订阅者。 */
export function enqueueNotification(task: BackgroundTask): void {
  if (task.notified) return
  updateTask(task.id, { notified: true })
  queue.push(toNotification(task))
  for (const cb of subscribers) cb()
}

/** 取出并清空全部待发通知 */
export function drainNotifications(): TaskNotification[] {
  return queue.splice(0, queue.length)
}

/** 订阅通知到达；返回退订函数 */
export function onNotification(cb: () => void): () => void {
  subscribers.add(cb)
  return () => { subscribers.delete(cb) }
}

// ── 纯函数（无副作用，不调 Date/Math.random） ─────────────────────────
export function formatNotification(n: TaskNotification): string {
  const lines = [
    '<task-notification>',
    `<task-id>${n.id}</task-id>`,
    `<status>${n.status}</status>`,
    `<summary>${n.summary}</summary>`,
  ]
  if (n.result !== undefined) lines.push(`<result>${n.result}</result>`)
  if (n.outputFile !== undefined) lines.push(`<output-file>${n.outputFile}</output-file>`)
  lines.push('</task-notification>')
  return lines.join('\n')
}

export function formatTaskList(tasks: BackgroundTask[]): string {
  if (tasks.length === 0) return '（无后台任务）'
  return tasks.map(t => `${t.id} [${t.status}] ${t.description}`).join('\n')
}
