// src/workflow/resolve.ts
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 解析 workflow 脚本源：接受名字字符串或 { scriptPath } / { name } 引用。
 * - scriptPath：绝对或相对 cwd 的磁盘路径，读不到 → 明确报错。
 * - name：先 cwd/.deepcode/workflows/<name>.js，再 ~/.deepcode/workflows/<name>.js。
 * 工具与嵌套 workflow() 共用此逻辑，避免重复。
 */
export function resolveWorkflowScript(nameOrRef: unknown, cwd: string): string {
  const ref = (nameOrRef && typeof nameOrRef === 'object' ? nameOrRef : null) as { scriptPath?: unknown; name?: unknown } | null
  if (ref?.scriptPath != null) {
    const sp = String(ref.scriptPath)
    const absPath = isAbsolute(sp) ? sp : resolve(cwd, sp)
    if (!existsSync(absPath)) throw new Error(`Workflow script file not found: ${absPath}`)
    return readFileSync(absPath, 'utf8')
  }
  const name = typeof nameOrRef === 'string' ? nameOrRef : ref?.name != null ? String(ref.name) : ''
  if (!name) throw new Error('Workflow not found: (empty name)')
  const projectPath = join(cwd, '.deepcode', 'workflows', `${name}.js`)
  const userPath = join(homedir(), '.deepcode', 'workflows', `${name}.js`)
  if (existsSync(projectPath)) return readFileSync(projectPath, 'utf8')
  if (existsSync(userPath)) return readFileSync(userPath, 'utf8')
  throw new Error(`Workflow not found: ${name}`)
}
