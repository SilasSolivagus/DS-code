import { z } from 'zod'
import type { Tool } from './types.js'

const schema = z.object({
  seconds: z.number().int().min(1).max(3600).describe('等待的秒数（1–3600）'),
})

export const sleepTool: Tool<typeof schema> = {
  name: 'Sleep',
  description:
    '等待指定的秒数。用户随时可以中断等待。\n\n' +
    '当用户让你休息/等待，或你暂时无事可做、在等待某事发生时使用。\n\n' +
    '可与其他工具并发调用——不会互相干扰。\n\n' +
    '优于 `Bash(sleep ...)`：不会占用一个 shell 进程。\n\n' +
    '注意：每次唤醒消耗一次 API 调用，且提示缓存在 5 分钟不活动后过期，请据此权衡等待时长。',
  inputSchema: schema,
  isReadOnly: true,
  needsPermission: () => false,
  async call(input, ctx) {
    const start = Date.now()
    const targetMs = input.seconds * 1000
    await new Promise<void>(resolve => {
      const timer = setInterval(() => {
        if (ctx.signal.aborted || Date.now() - start >= targetMs) {
          clearInterval(timer)
          resolve()
        }
      }, 100)
    })
    if (ctx.signal.aborted) {
      const elapsed = Math.round((Date.now() - start) / 1000)
      return `已中断等待（已过 ${elapsed} 秒）`
    }
    return `已等待 ${input.seconds} 秒`
  },
}
