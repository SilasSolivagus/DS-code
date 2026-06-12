// src/commands.ts
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

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
  return template.replaceAll('$ARGUMENTS', args)
}

export const INIT_PROMPT = `请分析本项目并生成 CLAUDE.md 项目记忆文件。步骤：
1. 用 Glob/Read 查证 package.json（或同类清单）、README、主要源码目录结构与测试目录
2. 若已存在 CLAUDE.md 或 AGENTS.md，先读取，在其基础上补全而不是覆盖重写
3. 用 Write 写入 CLAUDE.md，内容包含三节：构建/测试/运行命令（从清单文件查证，不要猜）、架构要点（主要模块及职责，带路径）、代码风格约定（从现有代码归纳）
保持简洁：只写对后续编码任务有用的事实，不写营销性描述。`

/** /context 简版：按字符数估算各部分占比（≈4 字符/token），外加上次请求的真实 usage */
export function formatContext(
  messages: any[],
  lastUsage?: { prompt_tokens: number; prompt_cache_hit_tokens: number },
): string {
  const len = (v: any) => (typeof v === 'string' ? v.length : v == null ? 0 : JSON.stringify(v).length)
  let sys = 0, convo = 0, tool = 0
  for (const m of messages) {
    if (m.role === 'system') sys += len(m.content)
    else if (m.role === 'tool') tool += len(m.content)
    else { convo += len(m.content); if (m.tool_calls) tool += len(m.tool_calls) }
  }
  const tot = sys + convo + tool || 1
  const row = (label: string, n: number) => `${label}：${Math.round((n / tot) * 100)}%（≈${Math.round(n / 4)} tokens）`
  return [
    row('系统提示词', sys),
    row('对话文本', convo),
    row('工具调用与结果', tool),
    lastUsage
      ? `上次请求实际 prompt：${lastUsage.prompt_tokens} tokens（缓存命中 ${lastUsage.prompt_cache_hit_tokens}）`
      : '（尚无真实 usage）',
  ].join('\n')
}
