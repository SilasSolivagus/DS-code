// src/tools/exitWorktree.ts
import { z } from 'zod'
import type { Tool } from './types.js'
import { worktreeChanges, removeWorktree } from '../worktree.js'

const schema = z.object({
  action: z.enum(['keep', 'remove']).describe('"keep" 保留 worktree 与分支；"remove" 删除两者。'),
  discard_changes: z.boolean().optional().describe('当 action="remove" 且 worktree 有未提交文件或未合并提交时，必须传 true 确认丢弃，否则工具拒绝。'),
})

export const exitWorktreeTool: Tool<typeof schema> = {
  name: 'ExitWorktree',
  description: '退出当前 worktree 会话，恢复到原工作目录。action=keep 保留、remove 删除。',
  inputSchema: schema,
  isReadOnly: false,
  needsPermission: () => false,
  async call(input, ctx) {
    const ws = ctx.worktreeSession?.get()
    if (!ctx.worktreeSession || !ws) return '当前不在 worktree 会话中，无需退出。'
    // hookBased 路径：跳过 git 改动检测；remove 时发 WorktreeRemove hook；keep 时只恢复 cwd
    if (ws.hookBased) {
      ctx.setCwd(ws.originalCwd)
      ctx.worktreeSession.set(null)
      if (input.action === 'remove') {
        await ctx.hookDispatch?.('WorktreeRemove', { hook_event_name: 'WorktreeRemove', worktree_path: ws.worktreePath }).catch(() => {})
        return `已退出并移除 worktree（${ws.worktreePath}）。会话已回到 ${ws.originalCwd}。`
      }
      return `已退出 worktree，工作保留在 ${ws.worktreePath}（hook-based）。会话已回到 ${ws.originalCwd}。`
    }
    if (input.action === 'remove' && !input.discard_changes) {
      const ch = await worktreeChanges(ws.worktreePath, ws.headCommit)
      if (ch.changedFiles > 0 || ch.commits > 0) {
        return `worktree 有 ${ch.changedFiles} 个未提交文件、${ch.commits} 个提交（分支 ${ws.worktreeBranch}）。删除会永久丢弃这些工作。请与用户确认后，用 discard_changes: true 重试——或用 action: "keep" 保留 worktree。`
      }
    }
    ctx.setCwd(ws.originalCwd)
    ctx.worktreeSession.set(null)
    if (input.action === 'remove') {
      await removeWorktree(ws)
      await ctx.hookDispatch?.('WorktreeRemove', { hook_event_name: 'WorktreeRemove', worktree_path: ws.worktreePath }).catch(() => {})
      return `已退出并删除 worktree（${ws.worktreePath}）。会话已回到 ${ws.originalCwd}。`
    }
    return `已退出 worktree，工作保留在 ${ws.worktreePath}（分支 ${ws.worktreeBranch}）。会话已回到 ${ws.originalCwd}。`
  },
}
