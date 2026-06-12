// src/index.ts
import { createClient } from './api.js'
import { startRepl } from './repl.js'

const argv = process.argv
const yolo = argv.includes('--yolo')
const continueSession = argv.includes('--continue') || argv.includes('-c')
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
    process.exit(r.status === 'done' ? 0 : 1)
  }
  await startRepl({ client, yolo, continueSession })
  process.exit(0)
} catch (e: any) {
  console.error(e?.message ?? e)
  process.exit(1)
}
