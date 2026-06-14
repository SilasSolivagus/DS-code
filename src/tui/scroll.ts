// src/tui/scroll.ts
// 纯滚动数学（无 React/ink 依赖，全单测）：钳位、翻页、auto-follow、位置提示。
// scrollOffset：0=顶，maxScroll=底（maxScroll = max(0, totalH - viewportH)）。

export function clamp(offset: number, maxScroll: number): number {
  return Math.max(0, Math.min(offset, maxScroll))
}

/** 翻页：上/下移 (viewportH-1) 行（保留一行上下文），再钳位。 */
export function page(offset: number, dir: 'up' | 'down', viewportH: number, maxScroll: number): number {
  const delta = Math.max(1, viewportH - 1)
  return clamp(offset + (dir === 'up' ? -delta : delta), maxScroll)
}

/** auto-follow：贴底态返回 maxScroll（跟随新输出），否则把原 offset 钳回界内。 */
export function applyFollow(offset: number, maxScroll: number, stuck: boolean): number {
  return stuck ? maxScroll : clamp(offset, maxScroll)
}

/** 是否应重新贴底跟随：滚到底即重新 stuck。 */
export function nextStuck(offset: number, maxScroll: number): boolean {
  return offset >= maxScroll
}

export interface ScrollInfo {
  moreAbove: boolean
  moreBelow: boolean
  top: number
  bottom: number
  total: number
}

/** 视口位置提示：是否上下有更多 + 可见行区间。 */
export function scrollInfo(offset: number, viewportH: number, totalH: number): ScrollInfo {
  const maxScroll = Math.max(0, totalH - viewportH)
  const o = clamp(offset, maxScroll)
  return {
    moreAbove: o > 0,
    moreBelow: o < maxScroll,
    top: totalH === 0 ? 0 : o + 1,
    bottom: Math.min(o + viewportH, totalH),
    total: totalH,
  }
}
