// src/memory.ts
import path from 'node:path'

/** 纯格式化：把已找到的记忆文件列表（findMemoryFiles 的结果）拼成 /memory 的展示串。零副作用、不读 fs。 */
export function formatMemory(found: string[], home: string): string {
  const global = path.join(home, '.deepcode', 'DEEPCODE.md')
  const lines: string[] = []

  if (found.length === 0) {
    lines.push('当前没有生效的记忆文件。')
  } else {
    lines.push('当前生效的记忆文件：')
    for (const p of found) lines.push(`  ${p}`)
  }

  if (!found.includes(global)) {
    lines.push(`全局记忆 ${global} 不存在，可创建。`)
  }

  lines.push('用 /init 生成项目 DEEPCODE.md；或直接用编辑器编辑上述文件 / 全局 ~/.deepcode/DEEPCODE.md。')

  return lines.join('\n')
}
