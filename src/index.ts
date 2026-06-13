// src/index.ts
import { createClient } from './api.js'

const argv = process.argv
const yolo = argv.includes('--yolo')
const continueSession = argv.includes('--continue') || argv.includes('-c')
const plain = argv.includes('--plain')
const pIdx = argv.indexOf('-p')

try {
  const client = createClient()
  if (pIdx !== -1) {
    const prompt = argv[pIdx + 1]
    if (!prompt || prompt.startsWith('-')) throw new Error('用法：deepcode -p "<任务>" [--json] [--yolo]')
    const { runHeadless } = await import('./headless.js')
    const r = await runHeadless({ client, prompt, yolo })
    if (argv.includes('--json')) {
      console.log(JSON.stringify({ text: r.text, status: r.status, turns: r.turns, usage: r.usage, costUSD: r.costUSD }))
    } else {
      console.log(r.text)
    }
    process.exitCode = r.status === 'done' ? 0 : 1
  } else if (!process.stdin.isTTY && !plain) {
    // 管道喂入无 -p：读 stdin 全文当 prompt 走 headless（CC 同款行为）
    const chunks: Buffer[] = []
    for await (const c of process.stdin) chunks.push(c)
    const prompt = Buffer.concat(chunks).toString('utf8').trim()
    if (!prompt) throw new Error('stdin 为空。交互模式请直接运行 deepcode，或用 -p "<任务>"')
    const { runHeadless } = await import('./headless.js')
    const r = await runHeadless({ client, prompt, yolo })
    console.log(r.text)
    process.exitCode = r.status === 'done' ? 0 : 1
  } else if (plain) {
    const { startRepl } = await import('./repl.js')
    await startRepl({ client, yolo, continueSession })
    process.exit(0) // readline 持有 event loop；需显式退出
  } else {
    const { startTui } = await import('./tui/index.js')
    await startTui({ client, yolo, continueSession })
    process.exit(0) // ink 卸载后 stdin raw 监听可能残留；显式退出兜底
  }
} catch (e: any) {
  console.error(e?.message ?? e)
  process.exitCode = 1
}
