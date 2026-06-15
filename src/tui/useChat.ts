// src/tui/useChat.ts
// 会话状态机的 React 实现。三层：
//  1. transcriptReducer：纯函数，LoopEvent/本地动作 → TranscriptItem[]（可独立测试）
//  2. createChatCore：与 React 无关的会话核心（session 持久化/compact/斜杠命令/usage，
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
import { makeWebFetchTool } from '../tools/webfetch.js'
import { makeAskUserQuestionTool, type Question, type Answer } from '../tools/askUserQuestion.js'
import { buildSystemPrompt, findMemoryFiles } from '../prompt.js'
import { formatMemory } from '../memory.js'
import { loadSettings, saveSettings } from '../config.js'
import { isDangerous, type Decision, type PermissionMode } from '../permissions.js'
import type { ToolContext } from '../tools/types.js'
import { newSession, openSession, listSessions, loadSession, type SessionHandle, type UsageRecord } from '../session.js'
import { costUSD } from '../pricing.js'
import { summarize, rebuildMessages } from '../compact.js'
import { TodoStore } from '../todo.js'
import { loadCustomCommands, expandCommand, INIT_PROMPT, formatContext } from '../commands.js'
import { exportTranscript } from '../export.js'
import os from 'node:os'
import { createCheckpointer, type Checkpointer } from '../checkpoint.js'
import { lastAssistantText, copyToClipboard } from '../clipboard.js'
import { sessionStats, formatStats } from '../stats.js'
import { formatKeybindings } from '../keybindings.js'

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

/** @path 展开为 <file> 块（≤400 行/文件）。
 *  - 仅匹配词首 @token（前面必须是行首或空白），避免误伤 email/git remote/@scoped 包名。
 *  - 读取失败：原文保持不变，路径收集到 misses 数组供调用方决定是否提示。
 */
export function expandAtRefs(text: string, cwd: string): { text: string; misses: string[] } {
  const misses: string[] = []
  const result = text.replace(/(^|\s)@([^\s]+)/g, (m, sep, p) => {
    try {
      const lines = fs.readFileSync(path.resolve(cwd, p), 'utf8').split('\n')
      const body = lines.slice(0, 400).join('\n') + (lines.length > 400 ? '\n…（截断）' : '')
      return `${sep}\n<file path="${p}">\n${body}\n</file>\n`
    } catch {
      misses.push(p)
      return m  // 原文不动
    }
  })
  return { text: result, misses }
}

export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; done: boolean }
  | { kind: 'reasoning'; text: string; done: boolean }
  | { kind: 'tool'; id: string; name: string; desc: string; running: boolean; ok?: boolean; preview?: string; previewExtra?: number; ms?: number }
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
        ? { ...it, running: false, ok: a.ok, preview: a.preview, previewExtra: a.previewExtra, ms: a.ms }
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
export interface PendingQuestion { questions: Question[]; resolve: (a: Answer[] | null) => void }

export interface ChatState {
  transcript: TranscriptItem[]
  busy: boolean
  model: string
  thinking: boolean
  permMode: PermissionMode
  pendingAsk: PendingAsk | null
  pendingQuestion: PendingQuestion | null
  usageLog: UsageRecord[]
  lastTokPerSec: number | null
  turnStartAt: number | null // 当前轮开始时间戳（spinner 计算耗时秒数；空闲为 null）
  turnOutTokens: number      // 当前轮累计输出 token（spinner 实时显示；流式估算，turn 边界用真实值校准）
  sessionCost(): number
  cacheHitRate(): number // usageLog 累计 hit/prompt，DeepSeek 状态行核心指标
  contextPct(): number // 上下文占比：lastPromptTokens / compactTokens（0-100），用于状态栏上下文条
}

export interface ChatCore {
  state: ChatState
  send(line: string): Promise<void> // 斜杠命令本地处理；其余走 runLoop（含边界 reminders、落盘、自动 compact）
  interrupt(): void // Esc
  resolveAsk(d: Decision): void // 权限弹窗回答
  resolveQuestion(answers: Answer[] | null): void // AskUserQuestion 弹窗回答
  resumeList(): { file: string; preview: string }[]
  resume(file: string): void
  customCommands: Map<string, string>
  /** React useSyncExternalStore 订阅口（onState 仍保留给非 React 消费者） */
  subscribe(listener: () => void): () => void
  rewindList(): { turnId: number; preview: string; fileCount: number }[]
  rewind(toTurnId: number, mode: 'conversation' | 'code' | 'both'): void
}

const HELP_TEXT =
  '/model  flash↔pro 切换\n/think  thinking 模式开关\n/accept acceptEdits 模式开关（Edit/Write 免确认，Bash 仍确认）\n/cost   本会话花费明细\n/context 上下文占比与上次 usage\n/stats  本会话统计（轮数/工具/token/缓存/花费）\n/copy   复制上条回复到剪贴板\n/memory 查看当前生效的记忆文件\n/compact 手动压缩对话历史\n/clear  清空对话（开新会话文件，花费累计保留）\n/resume 列出并恢复本目录历史会话\n/rewind 回退到某轮之前（仅对话/仅代码/两者）\n/export 导出对话到 markdown 文件\n/permissions 查看/删除已保存权限规则（/permissions rm <编号>）\n/init   分析项目生成 DEEPCODE.md\n/keybindings 查看快捷键\n/exit   退出\n自定义命令：~/.deepcode/commands/*.md 或 <项目>/.deepcode/commands/*.md（$ARGUMENTS 占位）'

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
  let model = settings.model ?? 'deepseek-v4-flash'
  let thinking = false
  let permMode: PermissionMode = opts.yolo ? 'yolo' : 'default'
  const todos = new TodoStore()
  let nextTurnId = 1
  let currentTurnId = 0
  const turnOf = new WeakMap<object, number>()  // user 消息对象 → turnId（跨 compact 存活：rebuildMessages 用 slice 保留引用）
  let checkpointer!: Checkpointer
  const checkpointStoreFor = (sessionFile: string) =>
    path.join(os.homedir(), '.deepcode', 'checkpoints', path.basename(sessionFile).replace(/\.jsonl$/, ''))

  const ctx: ToolContext = {
    cwd: () => cwd,
    setCwd: d => { cwd = d },
    get signal() { return abort.signal },
    fileState: new Map(),
    todos,
    recordBeforeImage: (absPath: string) => { if (currentTurnId > 0) checkpointer.capture(absPath, currentTurnId) },
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
  let pendingQuestion: PendingQuestion | null = null
  let lastTokPerSec: number | null = null
  let turnStartAt: number | null = null
  let turnOutTokens = 0

  const sessionCost = () =>
    usageLog.reduce((s, u) => s + costUSD(u.model, u.usage.prompt_tokens, u.usage.prompt_cache_hit_tokens, u.usage.completion_tokens), 0)
  const cacheHitRate = () => {
    const prompt = usageLog.reduce((s, u) => s + u.usage.prompt_tokens, 0)
    return prompt ? usageLog.reduce((s, u) => s + u.usage.prompt_cache_hit_tokens, 0) / prompt : 0
  }
  const contextPct = () =>
    settings.compactTokens ? Math.min(100, Math.round((lastPromptTokens / settings.compactTokens) * 100)) : 0

  // 所有状态变更走 setState：换新快照对象 → onState 回调 + 订阅者通知
  const listeners = new Set<() => void>()
  const snap = (): ChatState => ({
    transcript, busy, model, thinking, permMode, pendingAsk, pendingQuestion, usageLog, lastTokPerSec, turnStartAt, turnOutTokens, sessionCost, cacheHitRate, contextPct,
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

  /** 恢复会话到内存：消息、模型设置、fileState（mtime 校验）、usage，并续写该文件。返回恢复的 user 轮数。（恢复会话逻辑） */
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
    nextTurnId = loaded.maxTurnId + 1
    loaded.messages.forEach((m, i) => { if (loaded.messageTurnIds[i] !== undefined) turnOf.set(m, loaded.messageTurnIds[i]!) })
    checkpointer = createCheckpointer(checkpointStoreFor(file))
    return loaded.messages.filter(m => m.role === 'user').length
  }

  // 恢复（--continue）或新建会话
  const sessionDir = opts.sessionDir  // undefined → newSession/listSessions 使用默认路径
  const recovered = opts.continueSession ? listSessions(cwd, sessionDir)[0] : undefined
  if (recovered) {
    const turns = restoreSession(recovered.file)
    notice('info', `已恢复会话（${turns} 轮对话），继续写入 ${recovered.file}`)
  } else {
    session = newSession({ cwd, model, thinking, permMode }, sessionDir)
    session.appendMessage(messages[0]) // 持久化 system 消息
    checkpointer = createCheckpointer(checkpointStoreFor(session.file))
  }

  // AskUserQuestion 桥：挂起 Promise + pendingQuestion 状态，UI 用 resolveQuestion 回答
  const questionAsk = (questions: Question[]): Promise<Answer[] | null> =>
    new Promise<Answer[] | null>(res => {
      pendingQuestion = { questions, resolve: res }
      setState()
    })

  const tools = [
    ...allTools,
    todoWriteTool,
    makeAgentTool({
      client: opts.client,
      onUsage: (u, m) => { usageLog.push({ usage: u, model: m }); session.appendUsage(u, m) },
    }),
    makeWebFetchTool({
      client: opts.client,
      onUsage: (u, m) => { usageLog.push({ usage: u, model: m }); session.appendUsage(u, m) },
    }),
    makeAskUserQuestionTool({ ask: questionAsk }),
  ]

  /** compact：总结→重建消息→落盘 compact 记录与新前缀。失败不破坏现场（messages 仅在成功后替换）。 */
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

  /** 非斜杠输入：边界 reminders → user 消息落盘 → runLoop 驱动 →落盘 + 自动 compact */
  const runTurn = async (displayLine: string, userText: string): Promise<void> => {
    busy = true
    turnStartAt = Date.now()
    turnOutTokens = 0
    let sendOutTokens = 0 // 本次 send 累计真实输出 token（每个 turn_end 校准 turnOutTokens）
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
    const turnId = nextTurnId++
    currentTurnId = turnId
    const userMsg = {
      role: 'user',
      content: boundary.length ? `${userText}\n\n<system-reminder>\n${boundary.join('\n')}\n</system-reminder>` : userText,
    }
    turnOf.set(userMsg, turnId)
    messages.push(userMsg)
    session.appendMessage(userMsg, turnId) // user 输入即时落盘
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
          // spinner 实时输出 token 估算（非思考流；中文偏低估，仅作动态观感）
          if (!ev.reasoning) turnOutTokens += Math.ceil(ev.delta.length / 3)
          dispatch({ type: 'delta', delta: ev.delta, reasoning: !!ev.reasoning })
        } else if (ev.type === 'tool_start' || ev.type === 'tool_end') {
          dispatch(ev)
        } else if (ev.type === 'turn_end') {
          usageLog.push({ usage: ev.usage, model })
          session.appendUsage(ev.usage, model)
          lastPromptTokens = ev.usage.prompt_tokens
          // turn 边界用真实累计输出 token 校准估算值（覆盖本 turn 期间的粗估）
          sendOutTokens += ev.usage.completion_tokens
          turnOutTokens = sendOutTokens
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
    turnStartAt = null
    setState()
  }

  /** 斜杠命令本地处理（/resume 由 UI 走 resumeList/resume，/exit 归 UI） */
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
    if (line === '/keybindings') {
      notice('info', formatKeybindings())
      return
    }
    if (line === '/model' || line.startsWith('/model ')) {
      const arg = line.slice('/model'.length).trim()
      if (arg) {
        // /model <名>：切换到任意指定模型（配合自定义 baseURL 可接 OpenAI 兼容端点）
        model = arg
        const isDeepSeek = arg.startsWith('deepseek')
        const suffix = isDeepSeek ? '' : '（非 deepseek 系列计价按 0 估算）'
        session.appendMeta({ cwd, model, thinking, permMode })
        notice('info', `已切换到 ${model}${suffix}`)
      } else {
        // /model 无参：flash↔pro 轮换（从自定义模型返回时，落到 flash）
        model = model === 'deepseek-v4-flash' ? 'deepseek-v4-pro' : 'deepseek-v4-flash'
        session.appendMeta({ cwd, model, thinking, permMode })
        notice('info', `已切换到 ${model}`)
      }
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
      checkpointer = createCheckpointer(checkpointStoreFor(session.file))
      nextTurnId = 1; currentTurnId = 0
      dispatch({ type: 'clear' })
      notice('info', '对话已清空，已开新会话文件（本会话花费累计保留）')
      return
    }
    if (line === '/context') {
      notice('info', formatContext(messages, usageLog[usageLog.length - 1]?.usage))
      return
    }
    if (line === '/export' || line.startsWith('/export ')) {
      const arg = line.slice('/export'.length).trim()
      const base = path.basename(session.file ?? '').replace(/\.jsonl$/, '')
      const defaultName = base ? `deepcode-export-${base}.md` : 'deepcode-export.md'
      const dest = arg ? path.resolve(cwd, arg) : path.resolve(cwd, defaultName)
      const md = exportTranscript(messages, { model, cwd, exportedAt: new Date().toISOString() })
      try {
        fs.writeFileSync(dest, md)
        notice('info', `已导出到 ${dest}`)
      } catch (e: any) {
        notice('error', `[导出失败] ${e?.message ?? e}`)
      }
      return
    }
    if (line === '/copy') {
      const t = lastAssistantText(messages)
      if (!t) { notice('warn', '没有可复制的回复'); return }
      try {
        copyToClipboard(t)
        notice('info', `已复制上条回复到剪贴板（${t.length} 字）`)
      } catch (e: any) {
        notice('error', `复制失败：${e?.message ?? e}`)
      }
      return
    }
    if (line === '/stats') {
      notice('info', formatStats(sessionStats(messages, usageLog), sessionCost(), cacheHitRate()))
      return
    }
    if (line === '/memory') {
      notice('info', formatMemory(findMemoryFiles(cwd), os.homedir()))
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
      const { text: expanded, misses } = expandAtRefs(line, cwd)
      userText = expanded
      // 仅对路径形态的 miss（含 / 或 .）推送提示，邮箱/域名静默跳过
      for (const p of misses) {
        if (p.includes('/') || p.includes('.')) {
          notice('info', `（@路径未找到，按原文发送：@${p}）`)
        }
      }
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
      if (pendingQuestion) { const p = pendingQuestion; pendingQuestion = null; setState(); p.resolve(null) }
      abort.abort()
    },
    resolveAsk: (d: Decision) => {
      if (!pendingAsk) return
      const p = pendingAsk
      pendingAsk = null
      setState()
      p.resolve(d)
    },
    resolveQuestion: (answers: Answer[] | null) => {
      if (!pendingQuestion) return
      const p = pendingQuestion
      pendingQuestion = null
      setState()
      p.resolve(answers)
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
    rewindList: () => {
      const out: { turnId: number; preview: string; fileCount: number }[] = []
      for (const m of messages) {
        if (m.role !== 'user') continue
        const t = turnOf.get(m)
        if (t === undefined) continue
        const raw = typeof m.content === 'string' ? m.content.split('\n\n<system-reminder>')[0].replace(/\n/g, ' ') : ''
        out.push({ turnId: t, preview: raw.slice(0, 60), fileCount: checkpointer.fileCountAt(t) })
      }
      return out.reverse()
    },
    rewind: (toTurnId, mode) => {
      if (busy) return
      // 先做对话截断（会 slice transcript），再发各通知——否则 both 模式下代码还原通知会被一并切掉
      if (mode === 'conversation' || mode === 'both') {
        const mi = messages.findIndex(m => turnOf.get(m) === toTurnId)
        if (mi >= 0) {
          messages.length = mi
          const liveTurnIds = messages.filter(m => m.role === 'user' && turnOf.has(m)).map(m => turnOf.get(m)!)
          const pos = liveTurnIds.length
          let seen = 0, cut = transcript.length
          for (let i = 0; i < transcript.length; i++) {
            if (transcript[i].kind === 'user') { if (seen === pos) { cut = i; break } seen++ }
          }
          transcript = transcript.slice(0, cut)
          session.appendRewind(toTurnId)
          setState()
          notice('info', `[rewind] 对话已回退到第 ${toTurnId} 轮之前`)
        } else {
          // turnId 不在当前内存（多半已被 compact 压走）——不谎报成功
          notice('warn', `[rewind] 第 ${toTurnId} 轮已不在当前上下文（可能已被 compact），无法回退对话`)
        }
      }
      if (mode === 'code' || mode === 'both') {
        const r = checkpointer.restoreFiles(toTurnId)
        for (const p of [...r.restored, ...r.deleted]) ctx.fileState.delete(p)
        const parts = [`还原 ${r.restored.length} 文件`, r.deleted.length ? `删除 ${r.deleted.length} 新建` : '', r.failed.length ? `失败 ${r.failed.length}` : ''].filter(Boolean)
        notice('info', `[rewind] 代码：${parts.join('、')}`)
      }
    },
  }
}

export function useChat(core: ChatCore): ChatState {
  return useSyncExternalStore(core.subscribe, () => core.state)
}
