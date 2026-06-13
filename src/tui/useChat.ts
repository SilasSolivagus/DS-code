// src/tui/useChat.ts
// repl.ts 状态机的 React 化（repl.ts 冻结不动，语义逐条对齐）。三层：
//  1. transcriptReducer：纯函数，LoopEvent/本地动作 → TranscriptItem[]（可独立测试）
//  2. createChatCore：与 React 无关的会话核心（session 持久化/compact/斜杠命令/usage——逻辑对齐 repl.ts，
//     权限 ask 通过 pendingAsk 状态暴露给 UI，UI 用 resolveAsk 回答）
//  3. useChat：薄 React 包装（useSyncExternalStore 订阅 core）
import { useSyncExternalStore } from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import type OpenAI from 'openai'
import { runLoop, type LoopDeps, type LoopEvent } from '../loop.js'
import { allTools } from '../tools/index.js'
import { todoWriteTool } from '../tools/todowrite.js'
import { makeAgentTool } from '../tools/agent.js'
import { buildSystemPrompt } from '../prompt.js'
import { loadSettings, saveSettings } from '../config.js'
import { isDangerous, type Decision, type PermissionMode } from '../permissions.js'
import type { ToolContext } from '../tools/types.js'
import { newSession, openSession, listSessions, loadSession, type SessionHandle, type UsageRecord } from '../session.js'
import { costUSD } from '../pricing.js'
import { summarize, rebuildMessages } from '../compact.js'
import { TodoStore } from '../todo.js'
import { loadCustomCommands, expandCommand, INIT_PROMPT, formatContext } from '../commands.js'

/** ! 直跑：同步执行，30s 超时，stdout+stderr 合并，超 20k 截断 */
export function runBang(cmd: string, cwd: string): { output: string; code: number } {
  try {
    const out = execSync(cmd, { cwd, timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { output: out.slice(0, 20_000), code: 0 }
  } catch (e: any) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}` || String(e.message)
    return { output: out.slice(0, 20_000), code: e.status ?? 1 }
  }
}

/** @path 展开为 <file> 块（≤400 行/文件；缺失文件标注读取失败） */
export function expandAtRefs(text: string, cwd: string): string {
  // 匹配 @ 后的路径（含中文文件名）：直到遇到空格/换行/制表符为止
  return text.replace(/@([^\s]+)/g, (m, p) => {
    try {
      const lines = fs.readFileSync(path.resolve(cwd, p), 'utf8').split('\n')
      const body = lines.slice(0, 400).join('\n') + (lines.length > 400 ? '\n…（截断）' : '')
      return `\n<file path="${p}">\n${body}\n</file>\n`
    } catch { return `${m}（读取失败：文件不存在或不可读）` }
  })
}

export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; done: boolean }
  | { kind: 'reasoning'; text: string; done: boolean }
  | { kind: 'tool'; id: string; name: string; desc: string; running: boolean; ok?: boolean; preview?: string; ms?: number }
  | { kind: 'usage'; in: number; hit: number; out: number; totalIn: number; totalOut: number; cost: number }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  | { kind: 'bang'; cmd: string; output: string } // ! 直跑结果块（Task 9 填充）

export type ReducerAction =
  | { type: 'delta'; delta: string; reasoning: boolean }
  | LoopEvent & { type: 'tool_start' | 'tool_end' }
  | { type: 'turn_end'; usage: { prompt_tokens: number; completion_tokens: number; prompt_cache_hit_tokens: number }; totals?: { in: number; out: number; cost: number } }
  | { type: 'push'; item: TranscriptItem }
  | { type: 'seal' }  // 关闭所有未完成的 assistant/reasoning 块（空文本块直接丢弃）
  | { type: 'clear' }

/** 纯函数：永远返回新数组（React 状态纪律） */
export function transcriptReducer(state: TranscriptItem[], a: ReducerAction): TranscriptItem[] {
  if (a.type === 'delta') {
    const kind = a.reasoning ? ('reasoning' as const) : ('assistant' as const)
    // 追加到进行中的同类块；没有则新开一块
    for (let i = state.length - 1; i >= 0; i--) {
      const it = state[i]
      if (it.kind === kind && !it.done) {
        const next = [...state]
        next[i] = { ...it, text: it.text + a.delta }
        return next
      }
    }
    return [...state, { kind, text: a.delta, done: false }]
  }
  if (a.type === 'tool_start') {
    // 工具调用开始前先封闭所有进行中的 assistant/reasoning 块（复用 seal 语义）。
    // 保证 done 列表严格追加：文本块在工具条目之前进入 done，过滤后的索引稳定，
    // ink <Static> 不会出现中间插入导致工具行重复渲染或文本块永久丢失的问题。
    const sealed = transcriptReducer(state, { type: 'seal' })
    return [...sealed, { kind: 'tool', id: a.id, name: a.name, desc: a.desc, running: true }]
  }
  if (a.type === 'tool_end') {
    return state.map(it =>
      it.kind === 'tool' && it.id === a.id
        ? { ...it, running: false, ok: a.ok, preview: a.preview, ms: a.ms }
        : it,
    )
  }
  if (a.type === 'seal') {
    // 关闭所有进行中的 assistant/reasoning 块；空文本块直接丢弃（避免跨 turn 合并残留）
    return state
      .map(it =>
        (it.kind === 'assistant' || it.kind === 'reasoning') && !it.done ? { ...it, done: true } : it,
      )
      .filter(it => (it.kind === 'assistant' || it.kind === 'reasoning') ? it.text.length > 0 : true)
  }
  if (a.type === 'turn_end') {
    // 关闭所有进行中的 assistant/reasoning 块，并追加 usage 行（复用 seal 语义）
    const sealed = transcriptReducer(state, { type: 'seal' })
    const next: TranscriptItem[] = [...sealed]
    next.push({
      kind: 'usage',
      in: a.usage.prompt_tokens,
      hit: a.usage.prompt_cache_hit_tokens,
      out: a.usage.completion_tokens,
      totalIn: a.totals?.in ?? a.usage.prompt_tokens,
      totalOut: a.totals?.out ?? a.usage.completion_tokens,
      cost: a.totals?.cost ?? 0,
    })
    return next
  }
  if (a.type === 'push') return [...state, a.item]
  return [] // clear
}

export interface PendingAsk { toolName: string; desc: string; dangerous: boolean; resolve: (d: Decision) => void }

export interface ChatState {
  transcript: TranscriptItem[]
  busy: boolean
  model: string
  thinking: boolean
  permMode: PermissionMode
  pendingAsk: PendingAsk | null
  usageLog: UsageRecord[]
  lastTokPerSec: number | null
  sessionCost(): number
  cacheHitRate(): number // usageLog 累计 hit/prompt，DeepSeek 状态行核心指标
}

export interface ChatCore {
  state: ChatState
  send(line: string): Promise<void> // 斜杠命令本地处理；其余走 runLoop（含边界 reminders、落盘、自动 compact——逐项对齐 repl.ts 157-335）
  interrupt(): void // Esc
  resolveAsk(d: Decision): void // 权限弹窗回答
  resumeList(): { file: string; preview: string }[]
  resume(file: string): void
  customCommands: Map<string, string>
  /** React useSyncExternalStore 订阅口（onState 仍保留给非 React 消费者） */
  subscribe(listener: () => void): () => void
}

const HELP_TEXT =
  '/model  flash↔pro 切换\n/think  thinking 模式开关\n/accept acceptEdits 模式开关（Edit/Write 免确认，Bash 仍确认）\n/cost   本会话花费明细\n/context 上下文占比与上次 usage\n/compact 手动压缩对话历史\n/clear  清空对话（开新会话文件，花费累计保留）\n/resume 列出并恢复本目录历史会话\n/permissions 查看/删除已保存权限规则（/permissions rm <编号>）\n/init   分析项目生成 CLAUDE.md\n/exit   退出\n自定义命令：~/.deepcode/commands/*.md 或 <项目>/.deepcode/commands/*.md（$ARGUMENTS 占位）'

export function createChatCore(opts: {
  client: OpenAI
  yolo: boolean
  cwd: string
  continueSession?: boolean
  sessionDir?: string  // 测试注入：隔离 session 落盘目录，避免污染 ~/.deepcode/sessions
  onState: (s: ChatState) => void
}): ChatCore {
  const settings = loadSettings()
  let cwd = opts.cwd
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

  // —— UI 状态 ——
  let transcript: TranscriptItem[] = []
  let busy = false
  let pendingAsk: PendingAsk | null = null
  let lastTokPerSec: number | null = null

  const sessionCost = () =>
    usageLog.reduce((s, u) => s + costUSD(u.model, u.usage.prompt_tokens, u.usage.prompt_cache_hit_tokens, u.usage.completion_tokens), 0)
  const cacheHitRate = () => {
    const prompt = usageLog.reduce((s, u) => s + u.usage.prompt_tokens, 0)
    return prompt ? usageLog.reduce((s, u) => s + u.usage.prompt_cache_hit_tokens, 0) / prompt : 0
  }

  // 所有状态变更走 setState：换新快照对象 → onState 回调 + 订阅者通知
  const listeners = new Set<() => void>()
  const snap = (): ChatState => ({
    transcript, busy, model, thinking, permMode, pendingAsk, usageLog, lastTokPerSec, sessionCost, cacheHitRate,
  })
  let state = snap()
  const setState = (): void => {
    state = snap()
    opts.onState(state)
    for (const l of listeners) l()
  }
  const dispatch = (a: ReducerAction): void => {
    transcript = transcriptReducer(transcript, a)
    setState()
  }
  const notice = (level: 'info' | 'warn' | 'error', text: string): void =>
    dispatch({ type: 'push', item: { kind: 'notice', level, text } })

  /** 恢复会话到内存：消息、模型设置、fileState（mtime 校验）、usage，并续写该文件。返回恢复的 user 轮数。（对齐 repl.ts 48-72） */
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
    // 恢复后重置会话内状态，防止旧 todo/compact 标记/token 计数泄漏到新对话
    todos.reset(); compacted = false; lastPromptTokens = 0
    // doCompact 崩溃在 appendCompact 与首条 re-append 之间的兜底
    if (messages.length === 0 || messages[0]?.role !== 'system') {
      messages.unshift({ role: 'system', content: buildSystemPrompt(cwd) })
      session.appendMessage(messages[0])
    }
    return loaded.messages.filter(m => m.role === 'user').length
  }

  // 恢复（--continue）或新建会话（对齐 repl.ts 74-82）
  const sessionDir = opts.sessionDir  // undefined → newSession/listSessions 使用默认路径
  const recovered = opts.continueSession ? listSessions(cwd, sessionDir)[0] : undefined
  if (recovered) {
    const turns = restoreSession(recovered.file)
    notice('info', `已恢复会话（${turns} 轮对话），继续写入 ${recovered.file}`)
  } else {
    session = newSession({ cwd, model, thinking, permMode }, sessionDir)
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

  /** compact：总结→重建消息→落盘 compact 记录与新前缀。失败不破坏现场（messages 仅在成功后替换）。（对齐 repl.ts 94-109） */
  const doCompact = async (): Promise<void> => {
    notice('info', '[compact 总结中…]')
    const ac = new AbortController()
    const { summary, usage: u, truncated } = await summarize(opts.client, messages, ac.signal)
    usageLog.push({ usage: u, model: 'deepseek-v4-flash' })
    session.appendUsage(u, 'deepseek-v4-flash')
    const rebuilt = rebuildMessages(messages, summary)
    messages.length = 0
    messages.push(...rebuilt)
    session.appendCompact()
    for (const m of messages) session.appendMessage(m)
    compacted = true
    lastPromptTokens = 0
    notice('info', 'compact 完成：历史已压缩为总结 + 最近 8 条（fileState 保留）')
    if (truncated) notice('warn', '[compact 警告] 总结被长度截断，信息可能有损')
  }

  // 权限确认桥：挂起 Promise + pendingAsk 状态，UI 用 resolveAsk 回答
  const ask = (toolName: string, desc: string): Promise<Decision> =>
    new Promise<Decision>(res => {
      pendingAsk = { toolName, desc, dangerous: isDangerous(desc), resolve: res }
      setState()
    })

  /** 非斜杠输入：边界 reminders → user 消息落盘 → runLoop 驱动 →落盘 + 自动 compact（对齐 repl.ts 247-335） */
  const runTurn = async (displayLine: string, userText: string): Promise<void> => {
    busy = true
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
    dispatch({ type: 'push', item: { kind: 'user', text: displayLine } })
    const userMsg = {
      role: 'user',
      content: boundary.length ? `${userText}\n\n<system-reminder>\n${boundary.join('\n')}\n</system-reminder>` : userText,
    }
    messages.push(userMsg)
    session.appendMessage(userMsg) // user 输入即时落盘
    const lenBefore = messages.length
    abort = new AbortController()
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
      let firstDeltaAt: number | null = null // 本 turn 首个流式分片时间戳（tok/s 计算）
      let step
      while (!(step = await gen.next()).done) {
        const ev = step.value
        if (ev.type === 'text') {
          if (firstDeltaAt === null) firstDeltaAt = Date.now()
          dispatch({ type: 'delta', delta: ev.delta, reasoning: !!ev.reasoning })
        } else if (ev.type === 'tool_start' || ev.type === 'tool_end') {
          dispatch(ev)
        } else if (ev.type === 'turn_end') {
          usageLog.push({ usage: ev.usage, model })
          session.appendUsage(ev.usage, model)
          lastPromptTokens = ev.usage.prompt_tokens
          if (firstDeltaAt !== null) {
            lastTokPerSec = ev.usage.completion_tokens / Math.max((Date.now() - firstDeltaAt) / 1000, 0.001)
            firstDeltaAt = null
          }
          const totIn = usageLog.reduce((s, u) => s + u.usage.prompt_tokens, 0)
          const totOut = usageLog.reduce((s, u) => s + u.usage.completion_tokens, 0)
          dispatch({ type: 'turn_end', usage: ev.usage, totals: { in: totIn, out: totOut, cost: sessionCost() } })
          if (!costWarned && sessionCost() > settings.costWarnUSD) {
            costWarned = true
            notice('warn', `[花费提醒] 本会话已超 $${settings.costWarnUSD}（/cost 查看明细，阈值在 settings.json 的 costWarnUSD）`)
          }
        }
      }
      if (step.value === 'aborted') notice('warn', '[已中断]')
      if (step.value === 'max_turns') notice('error', '[达到最大轮数熔断]')
    } catch (e: any) {
      notice('error', `[错误] ${e?.message ?? e}`)
    } finally {
      // 中断或异常后封闭所有悬空的 assistant/reasoning 块，防止下一轮 delta 追加进旧块（跨 turn 合并 bug）
      dispatch({ type: 'seal' })
      // 本轮 loop 内部新增的 assistant/tool 消息补落盘 + fileState 快照
      for (const m of messages.slice(lenBefore)) session.appendMessage(m)
      session.appendFileState([...ctx.fileState])
    }

    // 自动 compact（落盘之后；busy 保持 true 直到 compact 结束）
    if (lastPromptTokens > settings.compactTokens) {
      try { await doCompact() } catch (e: any) { notice('error', `[自动 compact 失败，将在下轮重试] ${e?.message ?? e}`) }
    }
    busy = false
    setState()
  }

  /** 斜杠命令本地处理（对齐 repl.ts 161-245；/resume 由 UI 走 resumeList/resume，/exit 归 UI） */
  const send = async (line: string): Promise<void> => {
    line = line.trim()
    if (!line || busy) return
    // ! 直跑：执行 shell 命令，结果作为 bang transcript 块，同时以 XML 格式入上下文（不触发模型回复）
    if (line.startsWith('!')) {
      const cmd = line.slice(1).trim()
      const { output, code } = runBang(cmd, cwd)
      dispatch({ type: 'push', item: { kind: 'bang', cmd, output } })
      // 进入消息上下文（模型下次提问时可引用）
      const bangMsg = {
        role: 'user' as const,
        content: `<bash-input>${cmd}</bash-input>\n<bash-output>\n${output}\n</bash-output>`,
      }
      messages.push(bangMsg)
      session.appendMessage(bangMsg)
      if (code !== 0) notice('warn', `命令退出码 ${code}`)
      return
    }
    if (line === '/help') {
      notice('info', HELP_TEXT)
      return
    }
    if (line === '/model') {
      model = model === 'deepseek-v4-flash' ? 'deepseek-v4-pro' : 'deepseek-v4-flash'
      session.appendMeta({ cwd, model, thinking, permMode })
      notice('info', `已切换到 ${model}`)
      return
    }
    if (line === '/think') {
      thinking = !thinking
      session.appendMeta({ cwd, model, thinking, permMode })
      notice('info', `thinking 模式：${thinking ? '开' : '关'}`)
      return
    }
    if (line === '/accept') {
      if (opts.yolo) { notice('info', '当前是 yolo 模式，所有操作均已放行'); return }
      permMode = permMode === 'acceptEdits' ? 'default' : 'acceptEdits'
      session.appendMeta({ cwd, model, thinking, permMode })
      notice('info', `acceptEdits 模式：${permMode === 'acceptEdits' ? '开（Edit/Write 免确认，Bash 仍需确认）' : '关'}`)
      return
    }
    if (line === '/cost') {
      const inTok = usageLog.reduce((s, u) => s + u.usage.prompt_tokens, 0)
      const hitTok = usageLog.reduce((s, u) => s + u.usage.prompt_cache_hit_tokens, 0)
      const outTok = usageLog.reduce((s, u) => s + u.usage.completion_tokens, 0)
      notice('info', `本会话：输入 ${inTok}（缓存命中 ${hitTok}）出 ${outTok} | 估算花费 $${sessionCost().toFixed(6)}`)
      return
    }
    if (line === '/compact') {
      busy = true
      setState()
      try { await doCompact() } catch (e: any) { notice('error', `[compact 失败] ${e?.message ?? e}`) }
      busy = false
      setState()
      return
    }
    if (line === '/clear') {
      messages.length = 1 // 保留 system
      ctx.fileState.clear()
      todos.reset()
      compacted = false
      lastPromptTokens = 0
      session = newSession({ cwd, model, thinking, permMode }, sessionDir)
      session.appendMessage(messages[0])
      dispatch({ type: 'clear' })
      notice('info', '对话已清空，已开新会话文件（本会话花费累计保留）')
      return
    }
    if (line === '/context') {
      notice('info', formatContext(messages, usageLog[usageLog.length - 1]?.usage))
      return
    }
    if (line === '/permissions' || line.startsWith('/permissions ')) {
      const arg = line.slice('/permissions'.length).trim()
      const m = arg.match(/^rm\s+(\d+)$/)
      if (m) {
        const i = Number(m[1]) - 1
        if (settings.permissions.allow[i] !== undefined) {
          notice('info', `已删除：${settings.permissions.allow.splice(i, 1)[0]}`)
          saveSettings(settings)
        } else notice('warn', '编号无效')
      } else if (settings.permissions.allow.length) {
        notice('info', settings.permissions.allow.map((r, i) => `  ${i + 1}. ${r}`).join('\n') + '\n（/permissions rm <编号> 删除对应规则）')
      } else notice('info', '没有已保存的权限规则')
      return
    }

    // 斜杠命令：/init 和自定义命令；未知则报错
    let userText = line
    if (line === '/init') {
      userText = INIT_PROMPT
    } else if (line.startsWith('/')) {
      const [name, ...rest] = line.slice(1).split(' ')
      const tpl = customCommands.get(name)
      if (!tpl) { notice('warn', `未知命令 /${name}，/help 查看可用命令`); return }
      userText = expandCommand(tpl, rest.join(' '))
    } else {
      // 非斜杠输入：展开 @文件引用再发送
      userText = expandAtRefs(line, cwd)
    }
    await runTurn(line, userText)
  }

  return {
    get state() { return state },
    send,
    interrupt: () => {
      // 若权限弹窗挂起（pendingAsk），checkPermission 内的 ask Promise 永不 resolve，
      // generator 永不返回，busy 永远 true——必须先拒绝掉再 abort，否则死锁。
      if (pendingAsk) { const p = pendingAsk; pendingAsk = null; setState(); p.resolve('no') }
      abort.abort()
    },
    resolveAsk: (d: Decision) => {
      if (!pendingAsk) return
      const p = pendingAsk
      pendingAsk = null
      setState()
      p.resolve(d)
    },
    resumeList: () => listSessions(cwd, sessionDir).slice(0, 10).map(s => ({ file: s.file, preview: s.preview })),
    resume: (file: string) => {
      if (busy) return
      const turns = restoreSession(file)
      dispatch({ type: 'clear' }) // 换了会话，旧 transcript 不再对应当前 messages
      notice('info', `已恢复会话（${turns} 轮对话）`)
    },
    customCommands,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

export function useChat(core: ChatCore): ChatState {
  return useSyncExternalStore(core.subscribe, () => core.state)
}
