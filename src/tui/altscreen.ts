// src/tui/altscreen.ts
// alt-screen 全屏接管：进备用屏存主屏 + 清屏；leave 还原主屏 + 显光标（幂等）。
// 全路径还原：exit/SIGINT/SIGTERM/uncaughtException 任一都还原终端——这是最高优先正确性。
const ENTER = '\x1b[?1049h\x1b[2J\x1b[H'
const LEAVE = '\x1b[?1049l\x1b[?25h'

/** 进 alt-screen，返回幂等 leave()。write 可注入（测试用）。 */
export function enterAltScreen(write: (s: string) => void = s => { process.stdout.write(s) }): () => void {
  write(ENTER)
  let left = false
  return () => {
    if (left) return
    left = true
    write(LEAVE)
  }
}

/** 注册全路径还原；返回 disposer 摘除监听（正常卸载时调，避免泄漏）。 */
export function installCleanup(leave: () => void): () => void {
  const onExit = () => { leave() }
  const onSignal = (sig: NodeJS.Signals) => { leave(); process.exit(sig === 'SIGINT' ? 130 : 143) }
  const onUncaught = (err: unknown) => { leave(); throw err }
  process.once('exit', onExit)
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  process.once('uncaughtException', onUncaught)
  return () => {
    process.off('exit', onExit)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    process.off('uncaughtException', onUncaught)
  }
}
