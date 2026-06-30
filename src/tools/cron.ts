import { z } from 'zod'
import crypto from 'node:crypto'
import type { Tool } from './types.js'
import { getScheduler } from './scheduleWakeup.js'
import { parseCron } from '../services/scheduler/cron.js'

function genCronId(): string {
  const b = crypto.randomBytes(8); const C = '0123456789abcdefghijklmnopqrstuvwxyz'
  let s = ''; for (let i = 0; i < 8; i++) s += C[b[i] % 36]; return 'c' + s
}

const createSchema = z.object({
  cron: z.string().describe('5 字段 cron（本地时区）：分 时 日 月 周。如 "0 9 * * *"=每天 9 点'),
  prompt: z.string().describe('每次触发时入队的 prompt；自主循环传字面 <<autonomous-loop>>'),
  recurring: z.boolean().default(true).describe('true=每次匹配都触发（7 天后自动过期）；false=下次匹配触发一次后删除'),
  durable: z.boolean().default(false).describe('true=持久化到 <cwd>/.deepcode/scheduled_tasks.json 跨重启；false=仅本会话'),
})

export const cronCreateTool: Tool<typeof createSchema> = {
  name: 'CronCreate',
  description:
    '安排一个 prompt 在未来时间入队——按 cron 周期重复，或一次性。\n\n' +
    '标准 5 字段 cron，用户本地时区。recurring 任务 7 天后自动过期（最后触发一次再删，告知用户该 7 天上限）。durable:true 持久化到 .deepcode/scheduled_tasks.json 跨重启恢复，仅在用户明确要求长期保留时用。\n\n' +
    '只在 REPL 空闲（非查询中）触发。要实时盯日志/进程用 Monitor，不是 CronCreate。',
  inputSchema: createSchema,
  isReadOnly: true,
  needsPermission: () => false,
  async call(input) {
    const svc = getScheduler()
    if (!svc) return 'CronCreate 不可用（无活动会话调度器）。'
    if (!parseCron(input.cron)) return `cron 表达式无效：${input.cron}（需 5 字段，各字段在界内）`
    const id = genCronId()
    svc.addCron({ id, kind: 'cron', cron: input.cron, prompt: input.prompt, recurring: input.recurring, durable: input.durable, createdAt: Date.now(), nextFireAt: 0 })
    const note = input.recurring ? '（recurring，7 天后自动过期）' : '（一次性）'
    return `已安排 ${id}：${input.cron} ${note}${input.durable ? ' [durable]' : ''}`
  },
}

const listSchema = z.object({})
export const cronListTool: Tool<typeof listSchema> = {
  name: 'CronList',
  description: '列出本会话经 CronCreate 安排的所有 cron 任务（含 durable）。',
  inputSchema: listSchema,
  isReadOnly: true,
  needsPermission: () => false,
  async call() {
    const svc = getScheduler()
    if (!svc) return '（无活动调度器）'
    const crons = svc.list().filter(e => e.kind === 'cron')
    if (crons.length === 0) return '（无 cron 任务）'
    return crons.map((e: any) => `${e.id} ${e.cron} ${e.recurring ? 'recurring' : 'once'}${e.durable ? ' durable' : ''} → ${e.prompt.slice(0, 40)}`).join('\n')
  },
}

const delSchema = z.object({ id: z.string().describe('CronCreate 返回的任务 id') })
export const cronDeleteTool: Tool<typeof delSchema> = {
  name: 'CronDelete',
  description: '取消一个之前用 CronCreate 安排的 cron 任务。',
  inputSchema: delSchema,
  isReadOnly: true,
  needsPermission: () => false,
  async call(input) {
    const svc = getScheduler()
    if (!svc) return '（无活动调度器）'
    return svc.cancel(input.id) ? `已删除 ${input.id}` : `未找到 ${input.id}`
  },
}
