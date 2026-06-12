// src/repl.ts
import readline from 'node:readline'
import fs from 'node:fs'
import type OpenAI from 'openai'
import { runLoop, type LoopDeps } from './loop.js'
import { allTools } from './tools/index.js'
import { buildSystemPrompt } from './prompt.js'
import { loadSettings, saveSettings } from './config.js'
import { isDangerous, type Decision, type PermissionMode } from './permissions.js'
import type { ToolContext } from './tools/types.js'
import { newSession, openSession, listSessions, loadSession, type SessionHandle, type UsageRecord } from './session.js'
import { costUSD } from './pricing.js'
import { summarize, rebuildMessages } from './compact.js'
import { TodoStore } from './todo.js'
import { todoWriteTool } from './tools/todowrite.js'
import { makeAgentTool } from './tools/agent.js'
import { loadCustomCommands, expandCommand, INIT_PROMPT, formatContext } from './commands.js'

const C = { dim: '\x1b[2m', cyan: '\x1b[36m', red: '\x1b[31m', green: '\x1b[32m', reset: '\x1b[0m' }

export async function startRepl(opts: { client: OpenAI; yolo: boolean; continueSession?: boolean }): Promise<void> {
  const settings = loadSettings()
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  readline.emitKeypressEvents(process.stdin, rl)

  let cwd = process.cwd()
  let abort = new AbortController()
  let model = 'deepseek-v4-flash'
  let thinking = false
  let permMode: PermissionMode = opts.yolo ? 'yolo' : 'default'
  const todos = new TodoStore()
  const ctx: ToolContext = {
    cwd: () => cwd,
    setCwd: d => { cwd = d },
    get signal() { return abort.signal },
    fileState: new Map(),
    todos,
  }
  const messages: any[] = [{ role: 'system', content: buildSystemPrompt(cwd) }]
  const usageLog: UsageRecord[] = []
  let session!: SessionHandle
  let compacted = false       // compact 后首条用户消息的一次性提醒
  let lastPromptTokens = 0    // 自动 compact 触发依据
  let costWarned = false      // $阈值提醒只发一次
  const customCommands = loadCustomCommands(cwd)

  /** 恢复会话到内存：消息、模型设置、fileState（mtime 校验）、usage，并续写该文件。返回恢复的 user 轮数。 */
  const restoreSession = (file: string): number => {
    const loaded = loadSession(file)
    messages.length = 0
    messages.push(...loaded.messages)
    model = loaded.meta.model
    thinking = loaded.meta.thinking
    // yolo 必须每次启动显式 --yolo，恢复的模式只允许 default/acceptEdits（含篡改文件兜底）
    if (!opts.yolo) permMode = loaded.meta.permMode === 'acceptEdits' ? 'acceptEdits' : 'default'
    // fileState 按 mtime 校验：文件已变则丢弃该条（自动失效，迫使模型重读）
    ctx.fileState.clear()
    for (const [p, mtime] of loaded.fileState) {
      try { if (fs.statSync(p).mtimeMs === mtime) ctx.fileState.set(p, mtime) } catch { /* 文件没了，跳过 */ }
    }
    usageLog.length = 0
    usageLog.push(...loaded.usages)
    session = openSession(file)
    // Step 2b: doCompact 崩溃在 appendCompact 与首条 re-append 之间的兜底
    if (messages.length === 0 || messages[0]?.role !== 'system') {
      messages.unshift({ role: 'system', content: buildSystemPrompt(cwd) })
      session.appendMessage(messages[0])
    }
    return loaded.messages.filter(m => m.role === 'user').length
  }

  // 恢复（--continue）或新建会话
  const recovered = opts.continueSession ? listSessions(cwd)[0] : undefined
  if (recovered) {
    const turns = restoreSession(recovered.file)
    console.log(`已恢复会话（${turns} 轮对话），继续写入 ${recovered.file}`)
  } else {
    session = newSession({ cwd, model, thinking, permMode }, undefined)
    session.appendMessage(messages[0]) // 持久化 system 消息
  }

  const tools = [
    ...allTools,
    todoWriteTool,
    makeAgentTool({
      client: opts.client,
      onUsage: (u, m) => { usageLog.push({ usage: u, model: m }); session.appendUsage(u, m) },
    }),
  ]

  /** compact：总结→重建消息→落盘 compact 记录与新前缀。失败不破坏现场（messages 仅在成功后替换）。 */
  const doCompact = async (): Promise<void> => {
    process.stdout.write(`${C.dim}[compact 总结中…]${C.reset}`)
    const ac = new AbortController()
    const { summary, usage: u } = await summarize(opts.client, messages, ac.signal)
    usageLog.push({ usage: u, model: 'deepseek-v4-flash' })
    session.appendUsage(u, 'deepseek-v4-flash')
    const rebuilt = rebuildMessages(messages, summary)
    messages.length = 0
    messages.push(...rebuilt)
    session.appendCompact()
    for (const m of messages) session.appendMessage(m)
    compacted = true
    lastPromptTokens = 0
    console.log(` 完成：历史已压缩为总结 + 最近 8 条（fileState 保留）`)
  }

  const sessionCost = () => usageLog.reduce((s, u) => s + costUSD(u.model, u.usage.prompt_tokens, u.usage.prompt_cache_hit_tokens, u.usage.completion_tokens), 0)
  const shortModel = () => (model === 'deepseek-v4-pro' ? 'pro' : 'flash')
  const statusPrompt = () => {
    const tags = [shortModel()]
    if (thinking) tags.push('think')
    if (permMode === 'acceptEdits') tags.push('accept')
    if (permMode === 'yolo') tags.push('yolo')
    return `${C.dim}[${tags.join('·')} $${sessionCost().toFixed(4)}]${C.reset} › `
  }

  // 行缓冲：piped 输入在处理命令期间不丢失
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

  // Step 3: Ctrl+C 两次退出
  let lastSigint = 0
  rl.on('SIGINT', () => {
    const now = Date.now()
    if (now - lastSigint < 2000) { rl.close(); return }
    lastSigint = now
    process.stdout.write(`\n${C.dim}（再按一次 Ctrl+C 退出）${C.reset}\n`)
  })

  console.log(`deepcode | 模型 ${model}${opts.yolo ? '（yolo 模式）' : ''} | /help 查看命令，Esc 中断，Ctrl+C×2 或 /exit 退出`)

  while (true) {
    const line = (await question(statusPrompt())).trim()
    if (!line) continue
    if (line === '/exit') break
    if (line === '/help') {
      console.log('/model  flash↔pro 切换\n/think  thinking 模式开关\n/accept acceptEdits 模式开关（Edit/Write 免确认，Bash 仍确认）\n/cost   本会话花费明细\n/context 上下文占比与上次 usage\n/compact 手动压缩对话历史\n/clear  清空对话（开新会话文件，花费累计保留）\n/resume 列出并恢复本目录历史会话\n/permissions 查看/删除已保存权限规则（/permissions rm <编号>）\n/init   分析项目生成 CLAUDE.md\n/exit   退出\n自定义命令：~/.deepcode/commands/*.md 或 <项目>/.deepcode/commands/*.md（$ARGUMENTS 占位）')
      continue
    }
    if (line === '/model') {
      model = model === 'deepseek-v4-flash' ? 'deepseek-v4-pro' : 'deepseek-v4-flash'
      session.appendMeta({ cwd, model, thinking, permMode })
      console.log(`已切换到 ${model}`)
      continue
    }
    if (line === '/think') {
      thinking = !thinking
      session.appendMeta({ cwd, model, thinking, permMode })
      console.log(`thinking 模式：${thinking ? '开' : '关'}`)
      continue
    }
    if (line === '/accept') {
      if (opts.yolo) { console.log('当前是 yolo 模式，所有操作均已放行'); continue }
      permMode = permMode === 'acceptEdits' ? 'default' : 'acceptEdits'
      session.appendMeta({ cwd, model, thinking, permMode })
      console.log(`acceptEdits 模式：${permMode === 'acceptEdits' ? '开（Edit/Write 免确认，Bash 仍需确认）' : '关'}`)
      continue
    }
    if (line === '/cost') {
      const inTok = usageLog.reduce((s, u) => s + u.usage.prompt_tokens, 0)
      const hitTok = usageLog.reduce((s, u) => s + u.usage.prompt_cache_hit_tokens, 0)
      const outTok = usageLog.reduce((s, u) => s + u.usage.completion_tokens, 0)
      console.log(`本会话：输入 ${inTok}（缓存命中 ${hitTok}）出 ${outTok} | 估算花费 $${sessionCost().toFixed(6)}`)
      continue
    }
    if (line === '/resume') {
      const shown = listSessions(cwd).slice(0, 10)
      if (!shown.length) { console.log('本目录没有历史会话'); continue }
      shown.forEach((s, i) => console.log(`  ${i + 1}. ${s.preview}`))
      const pick = Number((await question('恢复哪个会话编号（回车取消）› ')).trim())
      if (!Number.isInteger(pick) || pick < 1 || pick > shown.length) { console.log('已取消'); continue }
      const turns = restoreSession(shown[pick - 1].file)
      console.log(`已恢复会话（${turns} 轮对话）`)
      continue
    }
    if (line === '/compact') {
      try { await doCompact() } catch (e: any) { console.error(`\n${C.red}[compact 失败] ${e?.message ?? e}${C.reset}`) }
      continue
    }
    if (line === '/clear') {
      messages.length = 1 // 保留 system
      ctx.fileState.clear()
      todos.reset()
      compacted = false
      lastPromptTokens = 0
      session = newSession({ cwd, model, thinking, permMode }, undefined)
      session.appendMessage(messages[0])
      console.log('对话已清空，已开新会话文件（本会话花费累计保留）')
      continue
    }
    if (line === '/context') {
      console.log(formatContext(messages, usageLog[usageLog.length - 1]?.usage))
      continue
    }
    if (line.startsWith('/permissions')) {
      const arg = line.slice('/permissions'.length).trim()
      const m = arg.match(/^rm\s+(\d+)$/)
      if (m) {
        const i = Number(m[1]) - 1
        if (settings.permissions.allow[i] !== undefined) {
          console.log(`已删除：${settings.permissions.allow.splice(i, 1)[0]}`)
          saveSettings(settings)
        } else console.log('编号无效')
      } else if (settings.permissions.allow.length) {
        settings.permissions.allow.forEach((r, i) => console.log(`  ${i + 1}. ${r}`))
        console.log('（/permissions rm <编号> 删除对应规则）')
      } else console.log('没有已保存的权限规则')
      continue
    }

    // 斜杠命令：/init 和自定义命令；未知则报错
    let userText = line
    if (line === '/init') {
      userText = INIT_PROMPT
    } else if (line.startsWith('/')) {
      const [name, ...rest] = line.slice(1).split(' ')
      const tpl = customCommands.get(name)
      if (!tpl) { console.log(`未知命令 /${name}，/help 查看可用命令`); continue }
      userText = expandCommand(tpl, rest.join(' '))
    }

    // 用户消息边界提醒：compact 一次性提示 + fileState 外部修改检测
    const boundary: string[] = []
    if (compacted) {
      boundary.push('以上对话历史为有损总结，修改任何关键文件前请先 Read 重新确认其当前内容。')
      compacted = false
    }
    for (const [p, mtime] of ctx.fileState) {
      try {
        if (fs.statSync(p).mtimeMs !== mtime) {
          boundary.push(`文件 ${p} 在你上次读取后被外部修改，使用前请重新 Read。`)
          ctx.fileState.delete(p)
        }
      } catch {
        boundary.push(`文件 ${p} 已被删除。`)
        ctx.fileState.delete(p)
      }
    }
    const userMsg = {
      role: 'user',
      content: boundary.length ? `${userText}\n\n<system-reminder>\n${boundary.join('\n')}\n</system-reminder>` : userText,
    }
    messages.push(userMsg)
    session.appendMessage(userMsg) // user 输入即时落盘
    const lenBefore = messages.length
    abort = new AbortController()
    const onKey = (_: string, key: any) => { if (key?.name === 'escape') abort.abort() }
    process.stdin.on('keypress', onKey)
    try {
      const deps: LoopDeps = {
        client: opts.client,
        tools,
        model,
        thinking,
        ctx,
        permission: {
          mode: permMode,
          rules: settings.permissions.allow,
          saveRule: r => { settings.permissions.allow.push(r); saveSettings(settings) },
          ask,
        },
        reminders: () => {
          todos.tick()
          const note = todos.staleReminder()
          return note ? [note] : []
        },
      }
      const gen = runLoop(messages, deps)
      let lastWasReasoning = false
      let step
      while (!(step = await gen.next()).done) {
        const ev = step.value
        if (ev.type === 'text') {
          if (lastWasReasoning && !ev.reasoning) process.stdout.write('\n')
          lastWasReasoning = !!ev.reasoning
          process.stdout.write(ev.reasoning ? `${C.dim}${ev.delta}${C.reset}` : ev.delta)
        }
        else if (ev.type === 'tool_start') process.stdout.write(`\n${C.cyan}⏺ ${ev.name}(${ev.desc.slice(0, 120)})${C.reset}`)
        else if (ev.type === 'tool_end') process.stdout.write(`\n${ev.ok ? C.green : C.red}  ⎿ ${ev.preview}（${(ev.ms / 1000).toFixed(1)}s）${C.reset}`)
        else if (ev.type === 'turn_end') {
          usageLog.push({ usage: ev.usage, model })
          session.appendUsage(ev.usage, model)
          const totIn = usageLog.reduce((s, u) => s + u.usage.prompt_tokens, 0)
          const totOut = usageLog.reduce((s, u) => s + u.usage.completion_tokens, 0)
          process.stdout.write(
            `\n${C.dim}[入 ${ev.usage.prompt_tokens}（缓存命中 ${ev.usage.prompt_cache_hit_tokens}）出 ${ev.usage.completion_tokens} | 累计 入 ${totIn} 出 ${totOut} $${sessionCost().toFixed(4)}]${C.reset}\n`,
          )
          lastPromptTokens = ev.usage.prompt_tokens
          if (!costWarned && sessionCost() > settings.costWarnUSD) {
            costWarned = true
            process.stdout.write(`\n${C.red}[花费提醒] 本会话已超 $${settings.costWarnUSD}（/cost 查看明细，阈值在 settings.json 的 costWarnUSD）${C.reset}\n`)
          }
        }
      }
      if (step.value === 'aborted') console.log(`\n${C.red}[已中断]${C.reset}`)
      if (step.value === 'max_turns') console.log(`\n${C.red}[达到最大轮数熔断]${C.reset}`)
    } catch (e: any) {
      console.error(`\n${C.red}[错误] ${e?.message ?? e}${C.reset}`)
    } finally {
      process.stdin.off('keypress', onKey)
      // 本轮 loop 内部新增的 assistant/tool 消息补落盘 + fileState 快照
      for (const m of messages.slice(lenBefore)) session.appendMessage(m)
      session.appendFileState([...ctx.fileState])
    }

    // 自动 compact（在 finally 落盘之后，当前轮消息已持久化，compact 记录清晰可恢复）
    if (lastPromptTokens > settings.compactTokens) {
      try { await doCompact() } catch (e: any) { console.error(`\n${C.red}[自动 compact 失败，将在下轮重试] ${e?.message ?? e}${C.reset}`) }
    }
  }
  rl.close()
}
