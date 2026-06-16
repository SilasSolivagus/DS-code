// src/tui/index.tsx
// TUI 入口：按逃生开关路由——内联 App vs 全屏 FullscreenApp（仅 TTY）。
// exitOnCtrlC: false 让根组件自管双击退出语义。
import React from 'react'
import { render } from 'ink'
import { App } from './App.js'
import { FullscreenApp } from './FullscreenApp.js'
import { enterAltScreen, installCleanup } from './altscreen.js'
import { makeMouseFilteredStdin } from './mouseStdin.js'
import { emitWheel } from './wheel.js'
import { installTaskCleanup, cleanupOldTaskLogs } from '../tasks.js'
import type OpenAI from 'openai'

export async function startTui(opts: {
  client: OpenAI
  yolo: boolean
  continueSession?: boolean
  inline?: boolean
}): Promise<void> {
  // 后台任务：退出时 kill running 任务（追加监听，不抢占下方 altscreen 清理）+ 清理超龄旧日志。
  installTaskCleanup()
  cleanupOldTaskLogs()
  // 全屏：默认开；inline 逃生开关 或 非 TTY 时退回内联 App。
  const fullscreen = !opts.inline && !!process.stdout.isTTY
  const Root = fullscreen ? FullscreenApp : App
  // 全屏：必须在 ink render() 之前同步进 alt-screen（备用屏+清屏+归位）+ 开 SGR 鼠标捕获（滚轮滚动），
  // 并由本处拥有退出还原。若放进组件 effect，effect 在 ink 首帧之后才跑，会导致 ink log-update 的
  // 光标位置假设错乱、整屏错位。鼠标序列在喂给 ink 前过滤（mouseStdin），滚轮转 emitWheel。
  let cleanupFull: (() => void) | undefined
  let customStdin: NodeJS.ReadStream | undefined
  if (fullscreen && process.stdout.isTTY) {
    const leaveAlt = enterAltScreen(s => { process.stdout.write(s) })
    process.stdout.write('\x1b[?1000h\x1b[?1006h') // 开鼠标按钮事件（含滚轮）+ SGR 扩展坐标
    const mf = makeMouseFilteredStdin(process.stdin, emitWheel)
    customStdin = mf.stdin
    const fullLeave = () => {
      try { process.stdout.write('\x1b[?1000l\x1b[?1006l') } catch { /* ignore */ } // 关鼠标捕获
      mf.cleanup()
      leaveAlt()
    }
    const dispose = installCleanup(fullLeave)
    cleanupFull = () => { dispose(); fullLeave() }
  }
  try {
    const { waitUntilExit } = render(
      <Root
        client={opts.client as any}
        yolo={opts.yolo}
        cwd={process.cwd()}
        continueSession={opts.continueSession}
      />,
      { exitOnCtrlC: false, ...(customStdin ? { stdin: customStdin } : {}) },
    )
    await waitUntilExit()
  } finally {
    cleanupFull?.()
  }
}
