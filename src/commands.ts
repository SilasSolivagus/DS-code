// src/commands.ts
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { estimateTextTokens } from './tokenEstimate.js'

/** 自定义命令：~/.deepcode/commands/*.md 与 <项目>/.deepcode/commands/*.md（项目优先），文件名即命令名 */
export function loadCustomCommands(cwd: string, home: string = os.homedir()): Map<string, string> {
  const out = new Map<string, string>()
  for (const dir of [path.join(home, '.deepcode', 'commands'), path.join(cwd, '.deepcode', 'commands')]) {
    let files: string[] = []
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')) } catch { continue }
    for (const f of files) {
      try { out.set(path.basename(f, '.md'), fs.readFileSync(path.join(dir, f), 'utf8')) } catch { /* 单文件坏了跳过 */ }
    }
  }
  return out
}

export function expandCommand(template: string, args: string): string {
  return template.replaceAll('$ARGUMENTS', () => args)
}

export const INIT_PROMPT = `请分析本项目并生成 DEEPCODE.md 项目记忆文件。步骤：
1. 用 Glob/Read 查证 package.json（或同类清单）、README、主要源码目录结构与测试目录
2. 若已存在 DEEPCODE.md、CLAUDE.md 或 AGENTS.md，先读取，在其基础上补全而不是覆盖重写
3. 用 Write 写入 DEEPCODE.md，内容包含三节：构建/测试/运行命令（从清单文件查证，不要猜）、架构要点（主要模块及职责，带路径）、代码风格约定（从现有代码归纳）
保持简洁：只写对后续编码任务有用的事实，不写营销性描述。`

// 把 5m/30s/1h/2d 间隔转 5-field cron（近似：分钟级用 */N，小时/天用整点）。
function intervalToCron(tok: string): string | null {
  const m = /^(\d+)(s|m|h|d)$/.exec(tok)
  if (!m) return null
  const n = Number(m[1])
  switch (m[2]) {
    case 's': case 'm': return `*/${Math.max(1, n)} * * * *`   // 秒近似为分钟（cron 最小分钟）
    case 'h': return n === 1 ? '0 * * * *' : `0 */${n} * * *`
    case 'd': return n === 1 ? '0 9 * * *' : `0 9 */${n} * *`
    default: return null
  }
}

export type LoopParse =
  | { mode: 'fixed'; cron: string; prompt: string }
  | { mode: 'dynamic'; prompt: string }
  | { mode: 'autonomous' }

export function parseLoopCommand(line: string): LoopParse {
  const rest = line.replace(/^\/loop\b/, '').trim()
  if (!rest) return { mode: 'autonomous' }
  const sp = rest.indexOf(' ')
  const first = sp < 0 ? rest : rest.slice(0, sp)
  const cron = intervalToCron(first)
  if (cron && sp >= 0) return { mode: 'fixed', cron, prompt: rest.slice(sp + 1).trim() }
  return { mode: 'dynamic', prompt: rest }
}

/** /loop 展开成给模型的编排指令（dynamic/autonomous 用；fixed 直接建 cron 无需指令）。 */
export const LOOP_GUIDANCE = {
  dynamic: (prompt: string) =>
    `你正处于 /loop 动态自定步模式。现在执行这个任务：\n\n${prompt}\n\n` +
    `做完本轮后，若任务需要继续，在 turn 末调用 ScheduleWakeup（prompt 设为同一任务文本）安排下次续跑；不需要继续就省略调用结束循环。`,
  autonomous: () =>
    `你正处于自主 /loop 模式。现在立即跑第一次自主检查，然后在 turn 末调用 ScheduleWakeup（prompt 设为字面 \`<<autonomous-loop-dynamic>>\`）保持循环；要停就省略调用。`,
}

/** /context 简版：按 CJK 感知 token 估算各部分占比，外加上次请求的真实 usage */
export function formatContext(
  messages: any[],
  lastUsage?: { prompt_tokens: number; prompt_cache_hit_tokens: number },
): string {
  const toText = (v: any): string => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v))
  const est = (v: any) => estimateTextTokens(toText(v))
  let sys = 0, convo = 0, tool = 0
  for (const m of messages) {
    if (m.role === 'system') sys += est(m.content)
    else if (m.role === 'tool') tool += est(m.content)
    else { convo += est(m.content); if (m.tool_calls) tool += est(m.tool_calls) }
  }
  const tot = sys + convo + tool || 1
  const row = (label: string, n: number) => `${label}：${Math.round((n / tot) * 100)}%（≈${n} tokens）`
  return [
    row('系统提示词', sys),
    row('对话文本', convo),
    row('工具调用与结果', tool),
    lastUsage
      ? `上次请求实际 prompt：${lastUsage.prompt_tokens} tokens（缓存命中 ${lastUsage.prompt_cache_hit_tokens}）`
      : '（尚无真实 usage）',
  ].join('\n')
}
