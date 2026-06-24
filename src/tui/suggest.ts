// src/tui/suggest.ts
import fs from 'node:fs'
import path from 'node:path'

export interface Suggestion { value: string; hint: string }

export const BUILTIN_COMMANDS: Suggestion[] = [
  { value: '/model', hint: 'flash↔pro 切换（/model <名> 指定）' },
  { value: '/think', hint: 'thinking 模式开关' },
  { value: '/accept', hint: 'acceptEdits 开关' },
  { value: '/cost', hint: '本会话花费明细' },
  { value: '/context', hint: '上下文占比' },
  { value: '/stats', hint: '本会话统计' },
  { value: '/copy', hint: '复制上条回复到剪贴板' },
  { value: '/memory', hint: '查看生效的记忆文件' },
  { value: '/compact', hint: '手动压缩历史' },
  { value: '/clear', hint: '清空对话' },
  { value: '/resume', hint: '恢复历史会话' },
  { value: '/fork', hint: '分叉当前会话继续' },
  { value: '/rename', hint: '给当前会话命名' },
  { value: '/export', hint: '导出对话到 markdown' },
  { value: '/config', hint: '查看合并配置与来源追溯' },
  { value: '/permissions', hint: '权限规则管理' },
  { value: '/init', hint: '生成 DEEPCODE.md' },
  { value: '/keybindings', hint: '查看快捷键' },
  { value: '/help', hint: '帮助' },
  { value: '/exit', hint: '退出' },
]

/** 遍历 cwd 下文件（深度≤3，跳过 node_modules/.git，上限 2000 个）做 @ 补全候选源 */
function listFiles(cwd: string, depth = 3): string[] {
  const out: string[] = []
  const walk = (dir: string, d: number) => {
    if (d > depth || out.length > 2000) return
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.git')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, d + 1)
      else out.push(path.relative(cwd, p))
    }
  }
  walk(cwd, 0)
  return out
}

export function computeSuggestions(input: string, env: { cwd: string; customCommands: Map<string, string>; skills?: { name: string; userInvocable: boolean }[] }): Suggestion[] {
  if (input.startsWith('/') && !input.includes(' ')) {
    // 合并 userInvocable skill 名（技能候选），与内置命令和自定义命令并排；skill 优先（先出现则去重后覆盖同名 customCommand）
    const skillItems = (env.skills ?? []).filter(s => s.userInvocable).map(s => ({ value: `/${s.name}`, hint: '技能' }))
    const all = [...BUILTIN_COMMANDS, ...skillItems, ...[...env.customCommands.keys()].map(n => ({ value: `/${n}`, hint: '自定义命令' }))]
    // 去重（skill 覆盖同名 customCommand）
    const seen = new Set<string>()
    const dedup = all.filter(s => !seen.has(s.value) && seen.add(s.value))
    const filtered = dedup.filter(s => s.value.startsWith(input))
    // 输入精确等于某命令全名时隐藏菜单，让回车直接提交该命令（对齐 CC）。
    // 否则补全菜单会永久接管回车：菜单对精确匹配仍显示该单项 → Suggestions 吞掉回车
    // → handlePick 设的 draft 与原值相同、App 的 suggestions useMemo 不重算 → 死锁。
    if (filtered.length === 1 && filtered[0].value === input) return []
    // bare "/" shows all; further prefix filtering caps at 8
    return input === '/' ? filtered : filtered.slice(0, 8)
  }
  const at = input.match(/@([\w./-]*)$/)
  if (at) {
    const q = at[1].toLowerCase()
    // 带目录的查询（含 /）按完整相对路径匹配，否则只按文件名模糊匹配
    const hit = q.includes('/')
      ? (f: string) => f.toLowerCase().includes(q)
      : (f: string) => path.basename(f).toLowerCase().includes(q)
    return listFiles(env.cwd)
      .filter(hit)
      .slice(0, 8)
      .map(f => ({ value: `@${f}`, hint: '' }))
  }
  return []
}
