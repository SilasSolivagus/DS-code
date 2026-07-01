#!/usr/bin/env node
// src/index.ts
import { createClient } from './api.js'
import { hasApiKey, loadSettings } from './config.js'

const argv = process.argv
const yolo = argv.includes('--yolo')
const continueSession = argv.includes('--continue') || argv.includes('-c')
const inlineFlag = argv.includes('--inline') || process.env.DEEPCODE_INLINE === '1'
const pIdx = argv.indexOf('-p')
const settingsFlagIdx = argv.indexOf('--settings')
const flagSettingsPath = settingsFlagIdx >= 0 ? argv[settingsFlagIdx + 1] : undefined
const bgRun = argv.includes('--background-run')
const resumeIdx = argv.indexOf('--resume')
const resumeFile = resumeIdx >= 0 ? argv[resumeIdx + 1] : undefined
const jobIdx = argv.indexOf('--job')
const jobShort = jobIdx >= 0 ? argv[jobIdx + 1] : undefined
const permIdx = argv.indexOf('--permission-mode')
const permMode = permIdx >= 0 ? argv[permIdx + 1] : undefined
const modelIdx = argv.indexOf('--model')
const modelFlag = modelIdx >= 0 ? argv[modelIdx + 1] : undefined

try {
  if (bgRun) {
    if (!resumeFile || !jobShort) throw new Error('--background-run 需 --resume <file> 与 --job <short>')
    const client = createClient(flagSettingsPath)
    const { runBackgroundSession } = await import('./backgroundRunner.js')
    // seed = -p 之后的值（父进程用 -p 传 seed）；无 -p 则续跑未完回合
    const seed = pIdx !== -1 ? argv[pIdx + 1] : undefined
    await runBackgroundSession({ client, resumeFile, jobShort, seed, yolo, permMode, model: modelFlag, flagSettingsPath })
    process.exit(0)
  } else if (pIdx !== -1) {
    const prompt = argv[pIdx + 1]
    if (!prompt || prompt.startsWith('-')) throw new Error('用法：deepcode -p "<任务>" [--json] [--yolo]')
    const client = createClient(flagSettingsPath)
    const { runHeadless } = await import('./headless.js')
    const r = await runHeadless({ client, prompt, yolo, flagSettingsPath })
    if (argv.includes('--json')) {
      console.log(JSON.stringify({ text: r.text, status: r.status, turns: r.turns, usage: r.usage, costCNY: r.costCNY }))
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
    const client = createClient(flagSettingsPath)
    const { runHeadless } = await import('./headless.js')
    const r = await runHeadless({ client, prompt, yolo, flagSettingsPath })
    console.log(r.text)
    process.exitCode = r.status === 'done' ? 0 : 1
  } else {
    // TTY 交互：无 key 先走首跑向导，再创建 client
    if (!hasApiKey()) {
      const { runSetup } = await import('./tui/setup.js')
      await runSetup()
    }
    const client = createClient(flagSettingsPath)
    const { startTui } = await import('./tui/index.js')
    await startTui({ client, yolo, continueSession, inline: inlineFlag || loadSettings(process.cwd(), flagSettingsPath).inline === true, flagSettingsPath })
    process.exit(0) // ink 卸载后 stdin raw 监听可能残留；显式退出兜底
  }
} catch (e: any) {
  console.error(e?.message ?? e)
  process.exitCode = 1
}
