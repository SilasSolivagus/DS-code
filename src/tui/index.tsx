// src/tui/index.tsx
// TUI 入口：按逃生开关路由——内联 App vs 全屏 FullscreenApp（仅 TTY）。
// exitOnCtrlC: false 让根组件自管双击退出语义。
import React from 'react'
import { render } from 'ink'
import { App } from './App.js'
import { FullscreenApp } from './FullscreenApp.js'
import type OpenAI from 'openai'

export async function startTui(opts: {
  client: OpenAI
  yolo: boolean
  continueSession?: boolean
  inline?: boolean
}): Promise<void> {
  // 全屏：默认开；inline 逃生开关 或 非 TTY 时退回内联 App。
  const fullscreen = !opts.inline && !!process.stdout.isTTY
  const Root = fullscreen ? FullscreenApp : App
  const { waitUntilExit } = render(
    <Root
      client={opts.client as any}
      yolo={opts.yolo}
      cwd={process.cwd()}
      continueSession={opts.continueSession}
    />,
    { exitOnCtrlC: false },
  )
  await waitUntilExit()
}
