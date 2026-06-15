// src/tui/wheel.ts
// 鼠标滚轮事件的极简 pub/sub：startTui 的过滤 stdin 解析出滚轮方向 → emitWheel；
// FullscreenApp 订阅 onWheel 驱动滚动。模块级单例（单 TUI 实例，足够）。
type WheelDir = 'up' | 'down'

const listeners = new Set<(d: WheelDir) => void>()

export function emitWheel(d: WheelDir): void {
  for (const l of listeners) l(d)
}

export function onWheel(cb: (d: WheelDir) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
