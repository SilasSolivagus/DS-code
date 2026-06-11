// src/repl.ts
import readline from 'node:readline'
import type OpenAI from 'openai'
import { runLoop, type LoopDeps } from './loop.js'
import { allTools } from './tools/index.js'
import { buildSystemPrompt } from './prompt.js'
import { loadSettings, saveSettings } from './config.js'
import { isDangerous, type Decision, type PermissionMode } from './permissions.js'
import type { ToolContext } from './tools/types.js'

const C = { dim: '\x1b[2m', cyan: '\x1b[36m', red: '\x1b[31m', green: '\x1b[32m', reset: '\x1b[0m' }

export async function startRepl(opts: { client: OpenAI; yolo: boolean }): Promise<void> {
  const settings = loadSettings()
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  readline.emitKeypressEvents(process.stdin, rl)

  let cwd = process.cwd()
  let abort = new AbortController()
  let model = 'deepseek-v4-flash'
  let thinking = false
  let permMode: PermissionMode = opts.yolo ? 'yolo' : 'default'
  const ctx: ToolContext = {
    cwd: () => cwd,
    setCwd: d => { cwd = d },
    get signal() { return abort.signal },
    fileState: new Map(),
  }
  const messages: any[] = [{ role: 'system', content: buildSystemPrompt(cwd) }]
  const totals = { input: 0, output: 0, cacheHit: 0 }

  // Buffer lines so piped input isn't lost while the loop processes a command.
  const lineQueue: string[] = []
  let lineWaiter: ((line: string) => void) | null = null
  let closed = false
  rl.on('line', line => {
    if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(line) }
    else lineQueue.push(line)
  })
  rl.on('close', () => {
    closed = true
    if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w('/exit') }
  })
  const question = (q: string) => new Promise<string>(res => {
    process.stdout.write(q)
    if (lineQueue.length) return res(lineQueue.shift()!)
    if (closed) return res('/exit')
    lineWaiter = res
  })
  const ask = async (toolName: string, desc: string): Promise<Decision> => {
    if (isDangerous(desc)) process.stdout.write(`\n${C.red}⚠ 高危操作；选 always 也只会精确放行这一条命令${C.reset}`)
    const a = (await question(`\n${C.cyan}允许 ${toolName}：${desc} ？ [y]是 / [n]否 / [a]总是允许 › ${C.reset}`))
      .trim().toLowerCase()
    return a === 'a' ? 'always' : a === 'y' ? 'yes' : 'no'
  }

  console.log(`deepcode | 模型 ${model}${opts.yolo ? '（yolo 模式）' : ''} | /help 查看命令，Esc 中断，/exit 退出`)

  while (true) {
    const line = (await question('\n› ')).trim()
    if (!line) continue
    if (line === '/exit') break
    if (line === '/help') {
      console.log('/model  flash↔pro 切换\n/think  thinking 模式开关\n/accept acceptEdits 模式开关（Edit/Write 免确认，Bash 仍确认）\n/exit   退出')
      continue
    }
    if (line === '/model') {
      model = model === 'deepseek-v4-flash' ? 'deepseek-v4-pro' : 'deepseek-v4-flash'
      console.log(`已切换到 ${model}`)
      continue
    }
    if (line === '/think') {
      thinking = !thinking
      console.log(`thinking 模式：${thinking ? '开' : '关'}`)
      continue
    }
    if (line === '/accept') {
      if (opts.yolo) {
        console.log('当前是 yolo 模式，所有操作均已放行')
        continue
      }
      permMode = permMode === 'acceptEdits' ? 'default' : 'acceptEdits'
      console.log(`acceptEdits 模式：${permMode === 'acceptEdits' ? '开（Edit/Write 免确认，Bash 仍需确认）' : '关'}`)
      continue
    }
    if (line.startsWith('/')) {
      console.log(`未知命令 ${line}，/help 查看可用命令`)
      continue
    }

    messages.push({ role: 'user', content: line })
    abort = new AbortController()
    const onKey = (_: string, key: any) => { if (key?.name === 'escape') abort.abort() }
    process.stdin.on('keypress', onKey)
    try {
      const deps: LoopDeps = {
        client: opts.client,
        tools: allTools,
        model,
        thinking,
        ctx,
        permission: {
          mode: permMode,
          rules: settings.permissions.allow,
          saveRule: r => { settings.permissions.allow.push(r); saveSettings(settings) },
          ask,
        },
      }
      const gen = runLoop(messages, deps)
      let step
      while (!(step = await gen.next()).done) {
        const ev = step.value
        if (ev.type === 'text') process.stdout.write(ev.delta)
        else if (ev.type === 'tool_start') process.stdout.write(`\n${C.cyan}⏺ ${ev.name}(${ev.desc.slice(0, 120)})${C.reset}`)
        else if (ev.type === 'tool_end') process.stdout.write(`\n${ev.ok ? C.green : C.red}  ⎿ ${ev.preview}${C.reset}`)
        else if (ev.type === 'turn_end') {
          totals.input += ev.usage.prompt_tokens
          totals.output += ev.usage.completion_tokens
          totals.cacheHit += ev.usage.prompt_cache_hit_tokens
          process.stdout.write(
            `\n${C.dim}[入 ${ev.usage.prompt_tokens}（缓存命中 ${ev.usage.prompt_cache_hit_tokens}）出 ${ev.usage.completion_tokens} | 累计 入 ${totals.input} 出 ${totals.output}]${C.reset}`,
          )
        }
      }
      if (step.value === 'aborted') console.log(`\n${C.red}[已中断]${C.reset}`)
      if (step.value === 'max_turns') console.log(`\n${C.red}[达到最大轮数熔断]${C.reset}`)
    } catch (e: any) {
      console.error(`\n${C.red}[错误] ${e?.message ?? e}${C.reset}`)
    } finally {
      process.stdin.off('keypress', onKey)
    }
  }
  rl.close()
}
