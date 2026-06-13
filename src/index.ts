#!/usr/bin/env node
// src/index.ts
import { createClient } from './api.js'
import { hasApiKey } from './config.js'

const argv = process.argv
const yolo = argv.includes('--yolo')
const continueSession = argv.includes('--continue') || argv.includes('-c')
const pIdx = argv.indexOf('-p')

try {
  if (pIdx !== -1) {
    const prompt = argv[pIdx + 1]
    if (!prompt || prompt.startsWith('-')) throw new Error('用法：deepcode -p "<任务>" [--json] [--yolo]')
    const client = createClient()
    const { runHeadless } = await import('./headless.js')
    const r = await runHeadless({ client, prompt, yolo })
    if (argv.includes('--json')) {
      console.log(JSON.stringify({ text: r.text, status: r.status, turns: r.turns, usage: r.usage, costUSD: r.costUSD }))
    } else {
      console.log(r.text)
    }
    process.exitCode = r.status === 'done' ? 0 : 1
  } else if (!process.stdin.isTTY) {
    // 管道喂入无 -p：读 stdin 全文当 prompt 走 headless（CC 同款行为）
    const chunks: Buffer[] = []
    for await (const c of process.stdin) chunks.push(c)
    const prompt = Buffer.concat(chunks).toString('utf8').trim()
    if (!prompt) throw new Error('stdin 为空。交互模式请直接运行 deepcode，或用 -p "<任务>"')
    const client = createClient()
    const { runHeadless } = await import('./headless.js')
    const r = await runHeadless({ client, prompt, yolo })
    console.log(r.text)
    process.exitCode = r.status === 'done' ? 0 : 1
  } else {
    // TTY 交互：无 key 先走首跑向导，再创建 client
    if (!hasApiKey()) {
      const { runSetup } = await import('./tui/setup.js')
      await runSetup()
    }
    const client = createClient()
    const { startTui } = await import('./tui/index.js')
    await startTui({ client, yolo, continueSession })
    process.exit(0) // ink 卸载后 stdin raw 监听可能残留；显式退出兜底
  }
} catch (e: any) {
  console.error(e?.message ?? e)
  process.exitCode = 1
}
