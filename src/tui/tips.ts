// src/tui/tips.ts — spinner tips 选择逻辑（照搬 CC：按会话计数冷却去重）。纯逻辑。

export interface TipContext { startupCount: number }

export interface Tip {
  id: string
  content: string
  cooldownSessions: number
  isRelevant: (ctx: TipContext) => boolean
}

export interface SpinnerTipsOverride { tips?: string[]; excludeDefault?: boolean }

export const DEFAULT_TIPS: Tip[] = [
  { id: 'new-user-warmup', content: '从小功能或 bug 修复开始，让 deepcode 先给出计划，再核对它建议的改动', cooldownSessions: 3, isRelevant: c => c.startupCount < 10 },
  { id: 'plan-mode', content: '复杂任务先按 Shift+Tab 进入 Plan 模式，让它先规划再动手', cooldownSessions: 5, isRelevant: () => true },
  { id: 'git-worktree', content: '用 EnterWorktree 在隔离的 git 工作树里并行跑多条任务，互不干扰', cooldownSessions: 10, isRelevant: () => true },
  { id: 'model-switch', content: '用 /model 在 DeepSeek / GLM 各档位之间切换', cooldownSessions: 10, isRelevant: () => true },
  { id: 'memory', content: '用 /memory 查看和管理 deepcode 的跨会话记忆', cooldownSessions: 15, isRelevant: () => true },
  { id: 'fork-rename', content: '用 /fork 复制会话试不同思路，用 /rename 给会话起名区分', cooldownSessions: 10, isRelevant: () => true },
  { id: 'steering', content: 'deepcode 干活时直接打字回车即可补充或转向，无需先打断', cooldownSessions: 8, isRelevant: () => true },
  { id: 'compact', content: '上下文变长时用 /compact 压缩，保留要点后继续干活', cooldownSessions: 12, isRelevant: () => true },
]

function buildCustomTips(override?: SpinnerTipsOverride): Tip[] {
  if (!override?.tips?.length) return []
  return override.tips.map((content, i) => ({
    id: `custom-${i}`, content, cooldownSessions: 0, isRelevant: () => true,
  }))
}

export function selectTip(input: {
  startupCount: number
  tipsHistory: Record<string, number>
  override?: SpinnerTipsOverride
  rng?: () => number
}): Tip | null {
  const { startupCount, tipsHistory, override, rng = Math.random } = input
  const base = override?.excludeDefault ? [] : DEFAULT_TIPS
  const pool = [...base, ...buildCustomTips(override)]
  const ctx: TipContext = { startupCount }
  const eligible = pool.filter(t => {
    if (!t.isRelevant(ctx)) return false
    const last = tipsHistory[t.id]
    const sinceShown = last === undefined ? Infinity : startupCount - last
    return sinceShown >= t.cooldownSessions
  })
  if (eligible.length === 0) return null
  return eligible[Math.floor(rng() * eligible.length)]
}

export function recordTipShown(id: string, startupCount: number, history: Record<string, number>): Record<string, number> {
  return { ...history, [id]: startupCount }
}
