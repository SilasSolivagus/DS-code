import { z } from 'zod'
import type { Tool } from './types.js'
import type { SchedulerService } from '../services/scheduler/index.js'
import { clampDelaySeconds } from '../services/scheduler/cron.js'

let scheduler: SchedulerService | null = null
export function setScheduler(svc: SchedulerService | null): void { scheduler = svc }
export function getScheduler(): SchedulerService | null { return scheduler }

const schema = z.object({
  delaySeconds: z.number().describe('多少秒后唤醒续跑（运行时钳到 [60,3600]）'),
  reason: z.string().describe('选择该间隔的一句话理由（写给自己看，落遥测/展示给用户）'),
  prompt: z.string().describe('唤醒时回灌的 /loop prompt；自主循环传字面哨兵 <<autonomous-loop-dynamic>>'),
})

export const scheduleWakeupTool: Tool<typeof schema> = {
  name: 'ScheduleWakeup',
  description:
    '在 /loop 动态模式下安排何时续跑——用户用 /loop（不带间隔）让你自定步长迭代某任务时用。\n\n' +
    '每轮把同一个 /loop prompt 经 `prompt` 传回，下次触发重复该任务。自主 /loop（无用户 prompt）则把字面哨兵 `<<autonomous-loop-dynamic>>` 作为 `prompt` 传入——runtime 在触发时解析回完整自主循环指令。省略本次调用 = 结束循环。\n\n' +
    '别用短间隔轮询你已起的后台工作——harness 跟踪的工作完成时会自动重新唤醒你，轮询是浪费。给一个长兜底（1200s+）让循环在工作挂起/从不通知时仍存活。例外：harness 无法跟踪的外部工作（CI/部署/远程队列），按其状态变化速度选间隔。\n\n' +
    'delaySeconds 运行时钳到 [60,3600]，无需自己钳。空闲心跳无具体信号时默认 1200–1800s。',
  inputSchema: schema,
  isReadOnly: true,
  needsPermission: () => false,
  async call(input) {
    if (!scheduler) {
      return 'Wakeup not scheduled. /loop 动态运行时未开启或循环已达上限——循环已结束，不要再发起。'
    }
    const secs = clampDelaySeconds(input.delaySeconds)
    scheduler.scheduleWakeup(secs, input.reason, input.prompt)
    return `Next wakeup scheduled in ${secs}s. 本轮无更多事可做——触发或 task-notification 到达时 harness 会重新唤醒你。`
  },
}
