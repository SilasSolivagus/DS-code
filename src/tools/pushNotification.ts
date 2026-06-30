import { z } from 'zod'
import fs from 'node:fs'
import type { Tool } from './types.js'

const BEL = '\x07'

/** 按终端类型选 OSC 转义。iTerm2→OSC 9；Ghostty→OSC 777；Kitty→OSC 99；未知→响铃兜底。 */
export function oscNotification(message: string, term = process.env.TERM_PROGRAM): string {
  const t = (term ?? '').toLowerCase()
  let osc: string
  if (t.includes('ghostty')) osc = `\x1b]777;notify;deepcode;${message}${BEL}`
  else if (t.includes('kitty')) osc = `\x1b]99;;${message}${BEL}`
  // iTerm2 与默认：OSC 9
  else osc = `\x1b]9;${message}${BEL}`
  // 末尾独立 BEL 响铃兜底：桌面通知未启用的终端至少响一声
  return osc + BEL
}

const schema = z.object({
  message: z.string().describe('通知正文，<200 字，一行，无 markdown。开头放用户要处理的事'),
  status: z.literal('proactive'),
})

export const pushNotificationTool: Tool<typeof schema> = {
  name: 'PushNotification',
  description:
    '在用户终端发桌面通知，把注意力从别处拉到本会话——这是成本，故宁可不发。\n\n' +
    '别为常规进度/刚问完还在看的事/快速完成发。在用户可能已离开且有值得回来的事时发，或用户明确要求时发。<200 字一行。',
  inputSchema: schema,
  isReadOnly: true,
  needsPermission: () => false,
  async call(input) {
    const msg = input.message.slice(0, 200).replace(/\n/g, ' ')
    const seq = oscNotification(msg)
    try {
      fs.writeFileSync('/dev/tty', seq)  // 直写控制终端，绕过 ink 全屏 stdout 渲染管理
    } catch {
      try { process.stdout.write(seq) } catch { /* 尽力而为 */ }
    }
    return `已发送桌面通知：${msg}`
  },
}
