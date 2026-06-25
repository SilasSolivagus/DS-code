// src/tools/enterWorktree.ts
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import type { Tool } from './types.js'
import { resolveGitRoot, createWorktree } from '../worktree.js'

const schema = z.object({
  name: z.string().optional().describe('worktree 名（省略=随机）'),
})

export const enterWorktreeTool: Tool<typeof schema> = {
  name: 'EnterWorktree',
  description: '创建一个隔离的 git worktree 并把当前会话切进去（同仓库、独立工作副本）。用 ExitWorktree 退出。',
  inputSchema: schema,
  isReadOnly: false,
  needsPermission: () => false, // 照搬 CC checkPermissions→allow
  async call(input, ctx) {
    if (!ctx.worktreeSession) return 'EnterWorktree 在当前上下文不可用。'
    if (ctx.worktreeSession.get()) throw new Error('已在 worktree 会话中（先 ExitWorktree 退出）。')
    const root = await resolveGitRoot(ctx.cwd())
    const name = input.name ?? `wt-${randomBytes(4).toString('hex')}`
    const originalCwd = ctx.cwd()
    if (!root) {
      // 非 git 仓库：尝试 WorktreeCreate hook 兜底
      const out = await ctx.hookDispatch?.('WorktreeCreate', { hook_event_name: 'WorktreeCreate', name }).catch(() => undefined)
      const hookPath = out?.additionalContext?.trim()
      if (!hookPath) throw new Error('当前目录不是 git 仓库，无法创建 worktree。')
      ctx.setCwd(hookPath)
      ctx.worktreeSession.set({ originalCwd, worktreePath: hookPath, worktreeBranch: '', headCommit: '', gitRoot: '', hookBased: true })
      return `已在 ${hookPath} 创建 worktree（hook-based）。会话已切入该 worktree。用 ExitWorktree 退出。`
    }
    const h = await createWorktree(root, name, ctx.worktreeConfig?.())
    ctx.setCwd(h.worktreePath)
    ctx.worktreeSession.set({ originalCwd, ...h })
    await ctx.hookDispatch?.('WorktreeCreate', { hook_event_name: 'WorktreeCreate', name, cwd: h.worktreePath }).catch(() => {})
    return `已在 ${h.worktreePath} 创建 worktree（分支 ${h.worktreeBranch}）。会话已切入该 worktree。用 ExitWorktree 退出。`
  },
}
