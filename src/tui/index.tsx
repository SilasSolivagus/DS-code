// src/tui/index.tsx
// TUI 入口：render App + waitUntilExit。exitOnCtrlC: false 让 App 自管双击退出语义。
import React from 'react'
import { render } from 'ink'
import { App } from './App.js'
import type OpenAI from 'openai'

export async function startTui(opts: {
  client: OpenAI
  yolo: boolean
  continueSession?: boolean
}): Promise<void> {
  const { waitUntilExit } = render(
    <App
      client={opts.client}
      yolo={opts.yolo}
      cwd={process.cwd()}
      continueSession={opts.continueSession}
    />,
    { exitOnCtrlC: false }, // Ctrl+C 语义由 App 自管（双击退出）
  )
  await waitUntilExit()
}
