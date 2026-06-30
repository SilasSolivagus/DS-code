// 文本 1:1 照搬 CC v2.1.193（spec 附录 A，bundle 实证）。

export const SENTINEL_CRON = '<<autonomous-loop>>'
export const SENTINEL_DYNAMIC = '<<autonomous-loop-dynamic>>'

export function isSentinel(p: string): boolean {
  return p === SENTINEL_CRON || p === SENTINEL_DYNAMIC
}

const PREAMBLE_HEAD =
  `# Autonomous loop check\n` +
  `The current conversation is your highest-signal source — re-read the transcript above, since everything there is something the user was actively engaged with. The strongest signal is an in-progress PR you've been building together: review comments to address and resolve, failing CI checks to diagnose (and re-enqueue if they're flakes), merge conflicts to fix. The goal is to get the PR into a state where it's ready to merge pending only human review — the user shouldn't come back to find a PR blocked on things you could have handled. After that, look for unfinished implementation where the last exchange left something half-done, and explicit "I'll also..." or "next I'll..." commitments the conversation made and didn't honor. Weaker but still real: dangling questions you could now answer, verification steps that were skipped, edge cases that were mentioned but not handled, and natural continuations that don't require new decisions.`

// 变体 A（默认 / 安静就停）
const PREAMBLE_TAIL_QUIET =
  `If you see earlier autonomous checks in this conversation, adjust your scope accordingly. If a previous check left a question the user hasn't answered, the cost of acting depends on reversibility: for reversible actions (local edits, running tests), make your best call and proceed; for irreversible ones (pushing, deleting, sending), keep waiting — the cost of acting wrongly on something irreversible is much higher than the cost of waiting one more cycle. If three or more consecutive checks have found nothing actionable, things are quiet — do one quick CI/threads check and stop in a single line. Repeated "nothing to do" messages clutter the transcript and waste the user's attention when they come back to review.`

// 变体 B（doneMeansMerged / 先扩范围再停）
const PREAMBLE_TAIL_PERSIST =
  `If you see earlier autonomous checks in this conversation, adjust your scope accordingly. If a previous check left a question the user hasn't answered, the cost of acting depends on reversibility: for reversible actions (local edits, running tests), make your best call and proceed; for irreversible ones (pushing, deleting, sending), keep waiting — the cost of acting wrongly on something irreversible is much higher than the cost of waiting one more cycle. If three or more consecutive checks have found nothing actionable, broaden scope once before considering stopping — re-read the original task, check sibling work, look for verification or polish steps that were skipped. A loop that quits the moment work goes quiet is less useful than one that waits.`

const TICK_CRON =
  `# Autonomous loop tick\n` +
  `Run the autonomous check using the loop instructions established earlier in this conversation. If you cannot find them, treat this as a no-op tick. The recurring cron will fire the next tick automatically — do not call ScheduleWakeup from this tick.`

const TICK_DYNAMIC =
  `# Autonomous loop tick (dynamic pacing)\n` +
  `Run the autonomous check using the loop instructions established earlier in this conversation. If you cannot find them, treat this as a no-op tick.\n` +
  `You scheduled this tick via the ScheduleWakeup tool (not a recurring cron). To keep the loop alive, call ScheduleWakeup again at the end of this turn with \`prompt\` set to the literal sentinel \`${SENTINEL_DYNAMIC}\` — otherwise the loop ends after this tick.`

/** 维护 first-fire 状态：首发 prepend preamble，后续只短 tick。reset 清状态（新循环/会话）。 */
export function createSentinelResolver(opts: { doneMeansMerged: () => boolean }) {
  let delivered = false
  return {
    resolve(prompt: string): string {
      if (!isSentinel(prompt)) return prompt
      const tick = prompt === SENTINEL_DYNAMIC ? TICK_DYNAMIC : TICK_CRON
      if (delivered) return tick
      delivered = true
      const tail = opts.doneMeansMerged() ? PREAMBLE_TAIL_PERSIST : PREAMBLE_TAIL_QUIET
      return `${PREAMBLE_HEAD}\n${tail}\n${tick}`
    },
    reset(): void { delivered = false },
  }
}
