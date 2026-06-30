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
import { makeAgentTool } from '../tools/agent.js'
import { makeWorkflowTool } from '../tools/workflow.js'
import { runSubagent } from '../subagentRunner.js'
import { makeWebFetchTool } from '../tools/webfetch.js'
import { makeWebSearchTool, resolveWebSearchConfig } from '../tools/webSearchTool.js'
import { makeAskUserQuestionTool, type Question, type Answer } from '../tools/askUserQuestion.js'
import { makeExitPlanModeTool, type AllowedPrompt } from '../tools/exitPlanMode.js'
import { bgTaskListTool, taskOutputTool, taskStopTool } from '../tools/taskTools.js'
import { taskCreateTool, taskGetTool, taskUpdateTool, taskListTool } from '../tools/taskListTools.js'
import { onNotification, drainNotifications, formatNotification, registerTask, updateTask, enqueueNotification, getTask, generateTaskId } from '../tasks.js'
import { runAutoDream } from '../services/memory/autoDream.js'
import { buildSystemPrompt, findMemoryFiles, PLAN_MODE_GUIDANCE } from '../prompt.js'
import { formatMemory } from '../memory.js'
import { loadSettings, loadRawUserSettings, saveRawUserSettings, addUserAllowRule, removeUserAllowRuleByValue, removeUserDenyRuleByValue, SETTINGS_FILE } from '../config.js'
import type { Settings } from '../config.js'
import { loadAppState, saveAppState } from '../tipsState.js'
import { selectTip, recordTipShown } from './tips.js'
import { formatPermissionRules, resolveRuleRemoval } from '../permissionsView.js'
import { loadLayeredSettings } from '../settingsLayers.js'
import { runHooks } from '../hooks.js'
import { makeHookRuntime } from '../hookRuntime.js'
import { isDangerous, type Decision, type PermissionMode, type PermissionDecisionReason } from '../permissions.js'
import { resolveDenyList, buildDenySourceMap } from '../deny.js'
import type { ToolContext, WorktreeSessionState } from '../tools/types.js'
import { newSession, openSession, listSessions, loadSession, sessionIdFromFile, stripBranchSuffix, nextBranchTitle, type SessionHandle, type UsageRecord } from '../session.js'
import { costCNY, cacheSavingsCNY } from '../pricing.js'
import { summarize, rebuildMessages, shouldAutoCompact } from '../compact.js'
import { estimateTextTokens, estimateMessagesTokens, effectiveThreshold } from '../tokenEstimate.js'
import { TaskListStore } from '../taskList.js'
import { loadCustomCommands, expandCommand, INIT_PROMPT, formatContext } from '../commands.js'
import { resolveAgents } from '../agentsLoader.js'
import { exportTranscript } from '../export.js'
import os from 'node:os'
import { createCheckpointer, type Checkpointer } from '../checkpoint.js'
import { lastAssistantText, copyToClipboard } from '../clipboard.js'
import { sessionStats, formatStats } from '../stats.js'
import { formatKeybindings } from '../keybindings.js'
import { attachMcpTools } from '../mcp.js'
import { loadSkills, substituteSkillArgs } from '../skillsLoader.js'
import { makeSkillTool } from '../tools/skill.js'
import { detectEffortKeyword } from '../text.js'
import { parseTokenBudget } from '../tokenBudget.js'
import { memdirFor, sessionMemoryPathFor, findGitRoot, sanitizeProjectKey } from '../memdir/paths.js'
import { DEFAULT_MEMORY_CONFIG } from '../memdir/memoryConfig.js'
import { createMemoryExtractor } from '../services/memory/extractMemories.js'
import { createRecaller } from '../services/memory/recall.js'
import { findRelevantMemories } from '../memdir/findRelevantMemories.js'
import { SteeringQueue, formatSteeringMessage, type SteeringItem } from '../steering.js'
import { type SessionMemoryState, shouldUpdateSessionMemory, runSessionMemoryUpdate } from '../services/memory/sessionMemory.js'
import { activeFastModel, activeProvider, belongsToProvider, modelList as providerModelList } from '../providers.js'
import { resolveResumeModel, rotateModel } from './resumeModel.js'
import { loadOutputStyles, resolveOutputStyle } from '../outputStyles.js'
import { createStatusLineRunner, execStatusLineCommand } from '../statusLine.js'
import { COMMIT_GUIDANCE, COMMIT_PUSH_PR_GUIDANCE, buildCommitContext, buildPrContext, isEmptyDiff, resolveBaseBranch } from '../commitGuidance.js'
import { expandTextPlaceholders, type Attachment, type ImageEntry, type TextEntry } from './pasteFold.js'
import { describeImage, GlmKeyMissingError } from '../imageDescribe.js'

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

export interface PendingAsk { toolName: string; desc: string; dangerous: boolean; reason?: PermissionDecisionReason; previewRule?: string; resolve: (d: Decision) => void }
export interface PendingQuestion { questions: Question[]; resolve: (a: Answer[] | null) => void }
export interface PendingPlanApproval { plan: string; allowedPrompts?: AllowedPrompt[]; resolve: (approved: boolean) => void }

/** 启动时算一次 spinner tip：递增会话计数→按冷却选一条→记录历史→持久化。返回 tip 文案或 null。 */
export function computeSpinnerTip(
  settings: Pick<Settings, 'spinnerTips' | 'spinnerTipsOverride'>,
  stateFile?: string,
  rng?: () => number,
): string | null {
  if (settings.spinnerTips === false) return null
  const st = stateFile ? loadAppState(stateFile) : loadAppState()
  st.startupCount += 1
  const tip = selectTip({ startupCount: st.startupCount, tipsHistory: st.tipsHistory, override: settings.spinnerTipsOverride, rng })
  if (tip) st.tipsHistory = recordTipShown(tip.id, st.startupCount, st.tipsHistory)
  if (stateFile) saveAppState(st, stateFile); else saveAppState(st)
  return tip?.content ?? null
}

/** 同步展开文本占位符（不含图片）。send 与 steer 共用，保证「入队前展开」（CC）。 */
export function expandTextAttachments(text: string, attachments?: Attachment[]): string {
  if (!attachments?.length) return text
  const textMap = new Map(
    attachments.filter(a => a.type === 'text').map(a => [a.id, { content: (a as TextEntry).content }]),
  )
  return expandTextPlaceholders(text, textMap)
}

/** 把 displayText 里的附件占位符解析成最终文本。Phase 2：文本同步展开 + 图片异步 describeImage 注入。 */
export async function resolveAttachments(
  text: string,
  attachments?: Attachment[],
  deps: { describe?: typeof describeImage; onStep?: (id: number) => void; onError?: (msg: string) => void } = {},
): Promise<string> {
  if (!attachments?.length) return text
  // 1) 展开文本占位符
  const textMap = new Map(
    attachments.filter(a => a.type === 'text').map(a => [a.id, { content: (a as TextEntry).content }]),
  )
  let out = expandTextPlaceholders(text, textMap)
  // 2) 图片占位符 → describeImage 注入
  const describe = deps.describe ?? describeImage
  const userText = out.replace(/\[Image #\d+\]/g, '').trim()
  for (const a of attachments) {
    if (a.type !== 'image') continue
    const img = a as ImageEntry
    deps.onStep?.(img.id)
    let injected: string
    try {
      const desc = await describe({ base64: img.base64, mime: img.mime }, userText)
      injected = `<图片#${img.id} 识别(glm-4.6v)>${desc}</图片#${img.id}>`
    } catch (e) {
      const reason = e instanceof GlmKeyMissingError ? '未配置 GLM key' : '识别失败'
      deps.onError?.(reason)
      injected = `<图片#${img.id} 无法识别：${reason}>`
    }
    out = out.replace(`[Image #${img.id}]`, () => injected)
  }
  return out
}

export interface ChatState {
  transcript: TranscriptItem[]
  busy: boolean
  model: string
  thinking: boolean
  effortLevel: 'low' | 'medium' | 'high'
  permMode: PermissionMode
  pendingAsk: PendingAsk | null
  pendingQuestion: PendingQuestion | null
  pendingPlanApproval: PendingPlanApproval | null
  usageLog: UsageRecord[]
  lastTokPerSec: number | null
  turnStartAt: number | null // 当前轮开始时间戳（spinner 计算耗时秒数；空闲为 null）
  turnOutTokens: number      // 当前轮累计输出 token（spinner 实时显示；流式估算，turn 边界用真实值校准）
  hookProgress: string | null // 1.7 当前运行中的慢阶段 hook 文案（null=无）
  spinnerTip: string | null // 5.10 本会话固定显示的 tip（null=关闭/无合格）
  sessionCost(): number
  cacheHitRate(): number // usageLog 累计 hit/prompt，DeepSeek 状态行核心指标
  cacheSavings(): number // usageLog 累计缓存省下金额（CNY），DeepSeek 状态行
  contextPct(): number // 上下文占比：lastPromptTokens / 生效阈值（0-100），用于状态栏上下文条
  contextUsed(): number // 上次真实 prompt_tokens（状态栏上下文条分子）
  contextWindow(): number // 当前模型生效阈值（状态栏上下文条分母）
  tokenBudget(): number | null // 2.1 sticky token 预算目标（null=未设）
  budgetUsed(): number // 2.1 本次/上次 send 累计输出 token（状态栏 budget 段分子）
  statusLineOutput: string | null // 5.7 自定义状态栏命令输出缓存（null=无/未设）
}

export interface ChatCore {
  state: ChatState
  send(line: string, attachments?: Attachment[]): Promise<void> // 斜杠命令本地处理；其余走 runLoop（含边界 reminders、落盘、自动 compact）
  interrupt(): void // Esc
  steer(text: string, attachments?: Attachment[]): void // busy 时 Enter：入队 next；若 toolInFlight 则同时软中断
  steerPop(): string | undefined
  steerQueue(): readonly SteeringItem[]
  resolveAsk(d: Decision): void // 权限弹窗回答
  resolveQuestion(answers: Answer[] | null): void // AskUserQuestion 弹窗回答
  resolvePlanApproval(approved: boolean): void // ExitPlanMode 计划审批回答
  resumeList(): { file: string; preview: string }[]
  resume(file: string): void
  customCommands: Map<string, string>
  skills: import('../skillsLoader.js').SkillDefinition[]
  /** React useSyncExternalStore 订阅口（onState 仍保留给非 React 消费者） */
  subscribe(listener: () => void): () => void
  rewindList(): { turnId: number; preview: string; fileCount: number }[]
  rewind(toTurnId: number, mode: 'conversation' | 'code' | 'both'): void
  /** 当前会话 cwd（EnterWorktree 切换后实时反映） */
  getCwd(): string
  /** 退订后台任务通知订阅，避免泄漏（core 生命周期 = 进程，App 无需调用；测试与正确性需要） */
  dispose(): void
  modelList(): import('../providers.js').ModelListItem[]
  applyModel(id: string): void
  outputStyleList(): { name: string; description: string }[]
  applyOutputStyle(name: string): void
}

/** 压缩（summarize LLM 调用）超时上限：到点自动 abort，防 provider 卡住流时 /compact 与自动压缩无限挂起。 */
export const COMPACT_TIMEOUT_MS = 120_000

const HELP_TEXT =
  '/model  无参打开模型选择器；/model <名> 直接切到指定模型\n/think  thinking 模式开关\n/effort 思考档位 low/medium/high/off\n/accept acceptEdits 模式开关（Edit/Write 免确认，Bash 仍确认）\n/plan   plan 模式开关（只读探索+写计划，ExitPlanMode 请用户审批）\n/add-dir <路径> 添加工作目录白名单（plan 模式围栏扩展）\n/cost   本会话花费明细\n/context 上下文占比与上次 usage\n/stats  本会话统计（轮数/工具/token/缓存/花费）\n/copy   复制上条回复到剪贴板\n/memory 查看当前生效的记忆文件\n/compact 手动压缩对话历史\n/clear  清空对话（开新会话文件，花费累计保留）\n/resume 列出并恢复本目录历史会话\n/rewind 回退到某轮之前（仅对话/仅代码/两者）\n/fork   分叉当前对话到新会话继续（原会话冻结，新会话标题加 (Branch)）\n/rename <名> 给当前会话命名（显示在 /resume 列表）\n/export 导出对话到 markdown 文件\n/permissions 查看/删除已保存权限规则（/permissions rm <编号>）\n/init   分析项目生成 DEEPCODE.md\n/keybindings 查看快捷键\n/output-style 选择输出风格（default/Explanatory/Learning/自定义）\n/commit 生成并创建 git commit（预跑 git 状态+遵循仓库风格，带 Co-Authored-By: deepcode）\n/commit-push-pr 提交+推送+创建或更新 PR（## Summary/## Test plan，需 gh CLI）\n/exit   退出\n自定义命令：~/.deepcode/commands/*.md 或 <项目>/.deepcode/commands/*.md（$ARGUMENTS 占位）'

export function createChatCore(opts: {
  client: OpenAI
  yolo: boolean
  cwd: string
  continueSession?: boolean
  sessionDir?: string  // 测试注入：隔离 session 落盘目录，避免污染 ~/.deepcode/sessions
  flagSettingsPath?: string
  onState: (s: ChatState) => void
  /** 测试注入：替换 extractMemories 内的 runSubagent，用 spy 验证触发 */
  runSubagent?: import('../services/memory/extractMemories.js').ExtractorDeps['runSubagent']
}): ChatCore {
  const layered = loadLayeredSettings(opts.cwd, opts.flagSettingsPath)
  const settings = layered.settings
  const ruleSources = layered.permissionSources.allow
  const denySources = buildDenySourceMap(layered.permissionSources.deny)
  let cwd = opts.cwd
  let abort = new AbortController()
  const steerQueue = new SteeringQueue()
  let toolsRunning = 0 // 并发 tool 计数；steer() 据此判定是否附带软中断
  let model = settings.model ?? activeFastModel()
  let tokenBudget: number | null = null // 2.1 sticky 预算（进程内，不落 session；+0k 清除）
  let budgetUsed = 0                     // 2.1 本次 send 累计输出 token（状态栏 budget 段分子）
  let thinking = false
  let effortLevel: 'low' | 'medium' | 'high' = 'medium'
  let permMode: PermissionMode = opts.yolo ? 'yolo' : 'default'
  let prePlanMode: PermissionMode = 'default'  // plan 模式进入前的模式，退出时恢复
  let additionalDirs: string[] = []            // /add-dir 会话内白名单（不落盘）
  const taskList = new TaskListStore()
  let nextTurnId = 1
  let currentTurnId = 0
  const turnOf = new WeakMap<object, number>()  // user 消息对象 → turnId（跨 compact 存活：rebuildMessages 用 slice 保留引用）
  let checkpointer!: Checkpointer
  const checkpointStoreFor = (sessionFile: string) =>
    path.join(os.homedir(), '.deepcode', 'checkpoints', sessionIdFromFile(sessionFile))

  let worktreeState: WorktreeSessionState | null = null
  const ctx: ToolContext = {
    cwd: () => cwd,
    setCwd: d => { cwd = d },
    denyPatterns: () => resolveDenyList(settings.permissions.deny),
    get signal() { return abort.signal },
    fileState: new Map(),
    taskList,
    recordBeforeImage: (absPath: string) => { if (currentTurnId > 0) checkpointer.capture(absPath, currentTurnId) },
    hookDispatch: (event, payload) => runHooks(event, payload, settings.hooks, hookDeps),
    sessionId: () => (session ? sessionIdFromFile(session.file) : undefined),
    worktreeSession: { get: () => worktreeState, set: s => { worktreeState = s } },
    worktreeConfig: () => settings.worktree,
  }
  const customCommands = loadCustomCommands(cwd)
  const agents = resolveAgents(cwd) // 内建 + 自定义合并后的注册表
  // Skills 接线：加载本地 skill 清单，建 injection buffer（inline skill 正文由此流入下一轮 user 消息）
  const skills = loadSkills(cwd, undefined, settings.skills)
  const injectionBuffer: string[] = []
  ctx.injectUserMessage = (c: string) => injectionBuffer.push(c)
  ctx.resetSignal = () => { abort = new AbortController() }
  const mem = settings.memory ?? DEFAULT_MEMORY_CONFIG
  const memdir = mem.enabled && !mem.recall.enabled ? memdirFor(cwd) : undefined
  // 动态召回：recall 开时构 recaller（prefetch 每轮非阻塞启动，consume 在 tool_end 后注入 reminder）
  const recaller = (mem.enabled && mem.recall.enabled)
    ? createRecaller({
        memdir: memdirFor(cwd),
        maxResults: mem.recall.maxResults,
        find: q => findRelevantMemories(opts.client, q, memdirFor(cwd), {
          maxResults: mem.recall.maxResults,
          model,
          signal: ctx.signal,
        }),
      })
    : null
  const outputStyleCache = loadOutputStyles()
  let outputStyleName = settings.outputStyle ?? 'default'
  const messages: any[] = [{ role: 'system', content: buildSystemPrompt(cwd, undefined, skills, settings.skills?.listingBudgetChars, memdir, resolveOutputStyle(outputStyleName, outputStyleCache)) }]
  const usageLog: UsageRecord[] = []
  let session!: SessionHandle
  let hookProgress: string | null = null
  const spinnerTip: string | null = computeSpinnerTip(settings)
  const hookDeps = {
    ...makeHookRuntime({
      client: opts.client,
      getModel: () => model,
      onUsage: (u, m) => { usageLog.push({ usage: u, model: m }); session.appendUsage(u, m) },
      cwd: () => cwd,
      onProgress: (label?: string) => { hookProgress = label ?? null; setState() },
    }),
    allowedHttpHookUrls: settings.allowedHttpHookUrls,
    httpHookAllowedEnvVars: settings.httpHookAllowedEnvVars,
  }
  let compactAbort: AbortController | null = null // 进行中压缩的中止句柄（超时 + interrupt/ESC 用；空闲为 null）
  let compacted = false       // compact 后首条用户消息的一次性提醒
  let lastPromptTokens = 0    // 自动 compact 触发依据
  let baselineLen = 0         // 与 lastPromptTokens 原子配对：lastPromptTokens 覆盖的 messages 前缀长度（发送前预估只估超出此前缀的新消息）
  let costWarned = false      // $阈值提醒只发一次
  let compactWarned = false   // 上下文≥90% 一次性提示
  const MAX_AUTO_COMPACT_FAILURES = 3
  let consecutiveCompactFailures = 0

  // —— UI 状态 ——
  let currentTitle: string | null = null
  let transcript: TranscriptItem[] = []
  let pendingPlanApproval: PendingPlanApproval | null = null
  let busy = false
  let pendingAsk: PendingAsk | null = null
  let pendingQuestion: PendingQuestion | null = null
  let lastTokPerSec: number | null = null
  let turnStartAt: number | null = null
  let turnOutTokens = 0

  const sessionCost = () =>
    usageLog.reduce((s, u) => s + costCNY(u.model, u.usage.prompt_tokens, u.usage.prompt_cache_hit_tokens, u.usage.completion_tokens), 0)
  // memory fork 使用记录回调：带 kind:'memory' 标签，仅驻内存不落盘
  // （appendUsage 无 kind 字段，落盘后 resume 读回会变普通 usage 绕过过滤，破坏闭合）
  const memoryOnUsage = (u: UsageRecord['usage'], m: string) => {
    usageLog.push({ usage: u, model: m, kind: 'memory' })
  }
  const cacheHitRate = () => {
    const main = usageLog.filter(u => u.kind !== 'memory')
    const prompt = main.reduce((s, u) => s + u.usage.prompt_tokens, 0)
    return prompt ? main.reduce((s, u) => s + u.usage.prompt_cache_hit_tokens, 0) / prompt : 0
  }
  const cacheSavings = () =>
    usageLog.filter(u => u.kind !== 'memory').reduce((s, u) => s + cacheSavingsCNY(u.model, u.usage.prompt_cache_hit_tokens), 0)
  const contextPct = () => {
    const thr = effectiveThreshold(model, settings.compactTokens)
    return thr ? Math.min(100, Math.round((lastPromptTokens / thr) * 100)) : 0
  }
  const contextUsed = () => lastPromptTokens
  const contextWindow = () => effectiveThreshold(model, settings.compactTokens)
  const tokenBudgetGet = () => tokenBudget
  const budgetUsedGet = () => budgetUsed

  // 所有状态变更走 setState：换新快照对象 → onState 回调 + 订阅者通知
  const listeners = new Set<() => void>()
  // 5.7 statusLine 输出（onChange 闭包按引用捕获 setState，运行期才调用，无 TDZ）
  let statusLineOutput: string | null = null
  const snap = (): ChatState => ({
    transcript, busy, model, thinking, effortLevel, permMode, pendingAsk, pendingQuestion, pendingPlanApproval, usageLog, lastTokPerSec, turnStartAt, turnOutTokens, hookProgress, spinnerTip, sessionCost, cacheHitRate, cacheSavings, contextPct, contextUsed, contextWindow, tokenBudget: tokenBudgetGet, budgetUsed: budgetUsedGet, statusLineOutput,
  })
  let state = snap()
  const setState = (): void => {
    state = snap()
    opts.onState(state)
    for (const l of listeners) l()
  }
  // 5.7 statusLine runner：仅当配置了命令才建
  const statusLineRunner = settings.statusLineCommand
    ? createStatusLineRunner({
        exec: () => execStatusLineCommand(settings.statusLineCommand!, {
          model, cwd, permission_mode: permMode, session_id: ctx.sessionId?.(),
        }),
        onChange: text => { statusLineOutput = text ?? null; setState() },
      })
    : undefined
  const refreshStatusLine = (): void => { statusLineRunner?.schedule() }
  // steering 队列变化驱动 React 重渲染（steer/steerPop → subscribe → setState）
  const unsubSteer = steerQueue.subscribe(setState)
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
    model = resolveResumeModel(loaded.meta.model, activeProvider())
    thinking = loaded.meta.thinking
    effortLevel = loaded.meta.effortLevel ?? 'medium'
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
    taskList.bind(sessionIdFromFile(session.file)); compacted = false; lastPromptTokens = 0; baselineLen = 0; consecutiveCompactFailures = 0; compactWarned = false
    // doCompact 崩溃在 appendCompact 与首条 re-append 之间的兜底
    if (messages.length === 0 || messages[0]?.role !== 'system') {
      messages.unshift({ role: 'system', content: buildSystemPrompt(cwd, undefined, skills, settings.skills?.listingBudgetChars, memdir, resolveOutputStyle(outputStyleName, outputStyleCache)) })
      session.appendMessage(messages[0])
    }
    nextTurnId = loaded.maxTurnId + 1
    loaded.messages.forEach((m, i) => { if (loaded.messageTurnIds[i] !== undefined) turnOf.set(m, loaded.messageTurnIds[i]!) })
    checkpointer = createCheckpointer(checkpointStoreFor(file))
    currentTitle = loaded.meta.title ?? null
    return loaded.messages.filter(m => m.role === 'user').length
  }

  // —— SessionStart：会话开始事件。构造同步 → fire-and-forget；additionalContext 缓冲到下一轮 runTurn 起始 flush。 ——
  let pendingSessionContext: string | null = null
  const fireSessionStart = (source: 'startup' | 'resume' | 'clear'): void => {
    if (!settings.hooks) return
    void runHooks('SessionStart', {
      hook_event_name: 'SessionStart', cwd, session_id: ctx.sessionId?.(), source,
    }, settings.hooks, hookDeps).then(out => {
      if (out.additionalContext) {
        pendingSessionContext = pendingSessionContext ? `${pendingSessionContext}\n\n${out.additionalContext}` : out.additionalContext
      }
      if (out.systemMessage) notice('info', out.systemMessage)
    }).catch(() => { /* SessionStart hook 失败不影响会话启动 */ })
  }

  // —— SessionEnd：会话结束事件。fire-and-forget；失败不阻断退出/清空。 ——
  const fireSessionEnd = (reason: 'clear' | 'exit'): void => {
    // drain 记忆提取（有界超时 3s，避免挂住退出）
    void Promise.race([extractor.drain(), new Promise(r => setTimeout(r, 3000))])
    if (!settings.hooks) return
    void runHooks('SessionEnd', {
      hook_event_name: 'SessionEnd', cwd, session_id: ctx.sessionId?.(), reason,
    }, settings.hooks, hookDeps).catch(() => { /* SessionEnd hook 失败不阻断退出/清空 */ })
  }

  // —— ConfigChange：会话内配置（权限规则）变更事件。fire-and-forget；失败不阻断保存。 ——
  const fireConfigChange = (): void => {
    if (!settings.hooks) return
    void runHooks('ConfigChange', {
      hook_event_name: 'ConfigChange', cwd, session_id: ctx.sessionId?.(),
      source: 'permissions', file_path: SETTINGS_FILE,
    }, settings.hooks, hookDeps).catch(() => { /* ConfigChange hook 失败不阻断保存 */ })
  }

  // 恢复（--continue）或新建会话
  const sessionDir = opts.sessionDir  // undefined → newSession/listSessions 使用默认路径
  const recovered = opts.continueSession ? listSessions(cwd, sessionDir)[0] : undefined
  if (recovered) {
    const turns = restoreSession(recovered.file)
    notice('info', `已恢复会话（${turns} 轮对话），继续写入 ${recovered.file}`)
    fireSessionStart('resume')
  } else {
    session = newSession({ cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id }, sessionDir)
    session.appendMessage(messages[0]) // 持久化 system 消息
    checkpointer = createCheckpointer(checkpointStoreFor(session.file))
    taskList.bind(sessionIdFromFile(session.file))
    currentTitle = null
    fireSessionStart('startup')
  }

  // —— 记忆提取器：每轮末 fire-and-forget onTurnEnd，退出/清空时 drain ——
  let extractor = createMemoryExtractor({
    client: opts.client, model, memdir: memdirFor(cwd), config: mem, ctx,
    runSubagent: opts.runSubagent, onUsage: memoryOnUsage,
  })

  // —— SessionMemory 状态：跨轮持久，resume/clear 时重置 ——
  let smState: SessionMemoryState = { promptTokens: 0, tokensAtLastUpdate: 0, initialized: false, toolCallsSinceUpdate: 0, lastTurnHadToolCalls: false }

  // —— autoDream：记录上次触发时间，每轮末门控后 fire-and-forget ——
  let dreamLastScanAt = 0

  // InstructionsLoaded：记忆文件加载记录（DEEPCODE.md/CLAUDE.md/全局）。fire-and-forget。
  if (settings.hooks) {
    const home = os.homedir()
    const globalMem = path.join(home, '.deepcode', 'DEEPCODE.md')
    for (const f of findMemoryFiles(cwd)) {
      void runHooks('InstructionsLoaded', {
        hook_event_name: 'InstructionsLoaded', cwd, session_id: ctx.sessionId?.(),
        file_path: f, memory_type: f === globalMem ? 'user' : 'project', load_reason: 'startup',
      }, settings.hooks, hookDeps).catch(() => {})
    }
  }

  // AskUserQuestion 桥：挂起 Promise + pendingQuestion 状态，UI 用 resolveQuestion 回答
  const questionAsk = (questions: Question[]): Promise<Answer[] | null> =>
    new Promise<Answer[] | null>(res => {
      pendingQuestion = { questions, resolve: res }
      setState()
    })

  // ExitPlanMode 审批桥：挂起 Promise + pendingPlanApproval 状态，UI 用 resolvePlanApproval 回答
  const approvePlan = (plan: string, allowedPrompts?: AllowedPrompt[]): Promise<{ approved: boolean }> =>
    new Promise<{ approved: boolean }>(res => {
      pendingPlanApproval = { plan, allowedPrompts, resolve: (approved: boolean) => res({ approved }) }
      setState()
    })

  const tools = [
    // allTools 中的静态 exitPlanModeTool 替换为工厂版（含审批回调）
    ...allTools.filter(t => t.name !== 'ExitPlanMode'),
    makeExitPlanModeTool({ approvePlan }),
    taskCreateTool,
    taskGetTool,
    taskUpdateTool,
    taskListTool,
    makeAgentTool({
      client: opts.client,
      onUsage: (u, m) => { usageLog.push({ usage: u, model: m }); session.appendUsage(u, m) },
      getModel: () => model,
      agents,
      worktree: settings.worktree,
    }),
    makeWorkflowTool({
      client: opts.client,
      onUsage: (u, m) => { usageLog.push({ usage: u, model: m }); session.appendUsage(u, m) },
      sessionModel: model,
      agents,
      runSubagent,
      journalDir: path.join(cwd, '.deepcode', 'workflows'),
    }),
    makeWebFetchTool({
      client: opts.client,
      onUsage: (u, m) => { usageLog.push({ usage: u, model: m }); session.appendUsage(u, m) },
    }),
    makeWebSearchTool({ config: resolveWebSearchConfig(settings) }),
    makeAskUserQuestionTool({ ask: questionAsk }),
    makeSkillTool(skills, {
      client: opts.client,
      onUsage: (u, m) => { usageLog.push({ usage: u, model: m }); session.appendUsage(u, m) },
      getModel: () => model, agents,
      skillPool: [...allTools, makeWebFetchTool({ client: opts.client, onUsage: (u, m) => { usageLog.push({ usage: u, model: m }); session.appendUsage(u, m) } })],
      listingBudgetChars: settings.skills?.listingBudgetChars,
    }),
    bgTaskListTool,
    taskOutputTool,
    taskStopTool,
  ]

  let mcpCleanup: (() => Promise<void>) | null = null
  // MCP 工具异步注入：不阻断 TUI 启动；工具 push 进同一 tools 引用，后续 turn 自动可见。
  void attachMcpTools(tools, settings.mcpServers, msg => notice('warn', msg)).then(cleanup => {
    mcpCleanup = cleanup
    setState()
  }).catch(() => {})

  /** compact：总结→重建消息→落盘 compact 记录与新前缀。失败不破坏现场（messages 仅在成功后替换）。 */
  const doCompact = async (trigger: 'auto' | 'manual' = 'auto'): Promise<void> => {
    notice('info', '[compact 总结中…]')
    // ac 须可被中止：① 超时定时器（防 provider 卡住流无限挂起）② interrupt()/ESC（compactAbort 引用）。
    const ac = new AbortController()
    compactAbort = ac
    const timeoutTimer = setTimeout(() => ac.abort(new Error(`compact 超时（${COMPACT_TIMEOUT_MS / 1000}s 内 provider 无响应）`)), COMPACT_TIMEOUT_MS)
    try {
      if (settings.hooks) {
        await runHooks('PreCompact', {
          hook_event_name: 'PreCompact', cwd, trigger, messages_count: messages.length,
        }, settings.hooks, hookDeps)
      }
      // SessionMemory 并入：若 summary.md 存在，将其内容作为 user 前置消息注入 summarize 输入，保留会话状态
      let messagesForSummarize = messages
      const sid = ctx.sessionId?.()
      if (mem.enabled && mem.sessionMemory.enabled && sid) {
        const smPath = sessionMemoryPathFor(cwd, sid, os.homedir())
        try {
          const smContent = fs.readFileSync(smPath, 'utf8')
          messagesForSummarize = [
            ...messages.slice(0, 1), // system
            { role: 'user', content: `<会话记忆>\n${smContent}\n</会话记忆>` },
            ...messages.slice(1),
          ]
        } catch { /* summary.md 不存在则跳过 */ }
      }
      const { summary, usage: u, truncated } = await summarize(opts.client, messagesForSummarize, ac.signal)
      const sub = activeFastModel()
      usageLog.push({ usage: u, model: sub })
      session.appendUsage(u, sub)
      const rebuilt = rebuildMessages(messages, summary)
      const before = messages.length
      messages.length = 0
      messages.push(...rebuilt)
      session.appendCompact()
      for (const m of messages) session.appendMessage(m)
      compacted = true
      lastPromptTokens = 0
      baselineLen = 0
      compactWarned = false
      if (settings.hooks) {
        await runHooks('PostCompact', {
          hook_event_name: 'PostCompact', cwd, trigger, summary, truncated,
          messages_before: before, messages_after: messages.length,
        }, settings.hooks, hookDeps)
      }
      notice('info', 'compact 完成：历史已压缩为总结 + 最近 8 条（fileState 保留）')
      if (truncated) notice('warn', '[compact 警告] 总结被长度截断，信息可能有损')
    } finally {
      clearTimeout(timeoutTimer)
      compactAbort = null
    }
  }

  // 权限确认桥：挂起 Promise + pendingAsk 状态，UI 用 resolveAsk 回答
  const ask = (toolName: string, desc: string, reason?: PermissionDecisionReason, previewRule?: string): Promise<Decision> =>
    new Promise<Decision>(res => {
      // Notification hook：权限弹窗浮现给用户时通知（桌面通知转发等）。fire-and-forget。
      if (settings.hooks) {
        void runHooks('Notification', {
          hook_event_name: 'Notification', cwd, session_id: ctx.sessionId?.(),
          notification_type: 'permission', title: 'deepcode 需要确认', message: `${toolName}: ${desc}`,
        }, settings.hooks, hookDeps).catch(() => {})
      }
      pendingAsk = { toolName, desc, dangerous: isDangerous(desc), reason, previewRule, resolve: res }
      setState()
    })

  /** 非斜杠输入：边界 reminders → user 消息落盘 → runLoop 驱动 →落盘 + 自动 compact */
  const runTurn = async (displayLine: string, userText: string): Promise<void> => {
    // UserPromptSubmit hook：用户输入提交前。block/preventContinuation→拦截不发；additionalContext→附到 user 文本。
    // 守卫与 loop.ts 的 `if (deps.hooks)` 一致：未配 hooks 时不引入额外 await（保持 idle 唤醒时序）。
    if (settings.hooks) {
      const ups = await runHooks('UserPromptSubmit', {
        hook_event_name: 'UserPromptSubmit', cwd, prompt: userText,
      }, settings.hooks, hookDeps)
      if (ups.block || ups.preventContinuation) {
        dispatch({ type: 'push', item: { kind: 'user', text: displayLine } })
        notice('warn', `输入被 hook 拦截：${ups.blockReason ?? '（无原因）'}`)
        return
      }
      if (ups.additionalContext) userText = `${userText}\n\n<hook-context>\n${ups.additionalContext}\n</hook-context>`
    }
    // SessionStart 注入的上下文（若有）于本轮起始一次性并入用户文本（落在用户消息之前）。
    if (pendingSessionContext) {
      userText = `<hook-context>\n${pendingSessionContext}\n</hook-context>\n\n${userText}`
      pendingSessionContext = null
    }
    busy = true
    turnStartAt = Date.now()
    turnOutTokens = 0
    let sendOutTokens = 0 // 本次 send 累计真实输出 token（每个 turn_end 校准 turnOutTokens）
    // 用户消息边界提醒：compact 一次性提示 + plan 模式指引 + fileState 外部修改检测
    const boundary: string[] = []
    if (compacted) {
      boundary.push('以上对话历史为有损总结，修改任何关键文件前请先 Read 重新确认其当前内容。')
      compacted = false
    }
    // plan 模式：每轮注入指引，确保模型始终感知约束（仿 CC system-reminder 注入）
    if (permMode === 'plan') boundary.push(PLAN_MODE_GUIDANCE)
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
      // 关键词本轮临时升档（不改持久状态）
      const kw = detectEffortKeyword(userText)
      const turnThinking = kw ? true : thinking
      const turnEffort = kw ?? effortLevel
      // 2.1 Token budget：解析输入更新 sticky（+0k 清除/显式新值覆盖/无指令沿用），重置本 send 用量
      const parsedBudget = parseTokenBudget(userText)
      if (parsedBudget !== null) tokenBudget = parsedBudget === 0 ? null : parsedBudget
      budgetUsed = 0
      // recall: 用户提交后、跑 loop 前启动后台召回
      if (recaller) recaller.prefetch(userText)
      const deps: LoopDeps = {
        client: opts.client,
        tools,
        model,
        thinking: turnThinking,
        effortLevel: turnEffort,
        maxToolResultChars: settings.maxToolResultChars,
        ctx,
        permission: {
          mode: permMode,
          rules: settings.permissions.allow,
          deny: resolveDenyList(settings.permissions.deny),
          cwd,
          additionalDirs,
          saveRule: r => {
            addUserAllowRule(r)        // 持久化到 user scope（raw RMW）
            if (!settings.permissions.allow.includes(r)) settings.permissions.allow.push(r) // 内存合并即时生效
            ruleSources[r] = 'user'
            fireConfigChange()
          },
          ask,
          ruleSources,
          denySources,
        },
        reminders: () => {
          taskList.tick()
          const note = taskList.staleReminder()
          return note ? [note] : []
        },
        injectTaskNotifications: true, // 主会话：runLoop 终止点 drain 后台完成通知续跑
        hooks: settings.hooks,
        hookDeps,
        drainInjections: () => injectionBuffer.splice(0),
        drainSteering: () => steerQueue.drainAll().map(i => formatSteeringMessage(i.value)),
        ...(tokenBudget ? { tokenBudget } : {}), // 2.1 sticky 预算（有值才传）
      }
      const gen = runLoop(messages, deps)
      let firstDeltaAt: number | null = null // 本 turn 首个流式分片时间戳（tok/s 计算）
      let turnToolCalls = 0 // 本次内层 turn 工具调用数（维护 smState.toolCallsSinceUpdate）
      let atTurnStart = true // 每个内层 turn 开始时归零 turnToolCalls（防中断路径带入上轮脏值）
      let step
      while (!(step = await gen.next()).done) {
        if (atTurnStart) { turnToolCalls = 0; atTurnStart = false }
        const ev = step.value
        if (ev.type === 'text') {
          if (firstDeltaAt === null) firstDeltaAt = Date.now()
          // spinner 实时输出 token 估算（非思考流；CJK 感知加权，仅作动态观感）
          if (!ev.reasoning) turnOutTokens += estimateTextTokens(ev.delta)
          dispatch({ type: 'delta', delta: ev.delta, reasoning: !!ev.reasoning })
        } else if (ev.type === 'tool_start') {
          turnToolCalls++
          toolsRunning++
          dispatch(ev)
        } else if (ev.type === 'tool_end') {
          toolsRunning = Math.max(0, toolsRunning - 1)
          dispatch(ev)
          // recall: tool 结果回灌后 poll，与 drainInjections 同站点——已 settle 则注入 reminder
          if (recaller) {
            const readPaths = new Set(ctx.fileState.keys())
            const rem = recaller.consume(readPaths)
            if (rem) ctx.injectUserMessage!(rem)
          }
        } else if (ev.type === 'turn_end') {
          usageLog.push({ usage: ev.usage, model })
          session.appendUsage(ev.usage, model)
          lastPromptTokens = ev.usage.prompt_tokens
          // baselineLen 原子配对：lastPromptTokens 覆盖发送时的 messages 前缀（sentLen，含本轮 user，但不含本轮 assistant 产出）
          baselineLen = ev.sentLen
          // turn 边界用真实累计输出 token 校准估算值（覆盖本 turn 期间的粗估）
          sendOutTokens += ev.usage.completion_tokens
          turnOutTokens = sendOutTokens
          budgetUsed = sendOutTokens // 2.1 状态栏 budget 段分子（与本 send 输出累计同步）
          if (firstDeltaAt !== null) {
            lastTokPerSec = ev.usage.completion_tokens / Math.max((Date.now() - firstDeltaAt) / 1000, 0.001)
            firstDeltaAt = null
          }
          const totIn = usageLog.filter(u => u.kind !== 'memory').reduce((s, u) => s + u.usage.prompt_tokens, 0)
          const totOut = usageLog.filter(u => u.kind !== 'memory').reduce((s, u) => s + u.usage.completion_tokens, 0)
          dispatch({ type: 'turn_end', usage: ev.usage, totals: { in: totIn, out: totOut, cost: sessionCost() } })
          if (!costWarned && sessionCost() > settings.costWarnCNY) {
            costWarned = true
            notice('warn', `[花费提醒] 本会话已超 ¥${settings.costWarnCNY}（/cost 查看明细，阈值在 settings.json 的 costWarnCNY）`)
          }
          const warnThr = effectiveThreshold(model, settings.compactTokens)
          const ctxPct = warnThr ? (lastPromptTokens / warnThr) * 100 : 0
          if (!compactWarned && ctxPct >= 90) {
            compactWarned = true
            notice('warn', `上下文已用 ${Math.round(ctxPct)}%，接近自动压缩阈值`)
          }
          // smState 每轮更新（turn_end 是本 inner-turn 的边界）
          smState.promptTokens = ev.usage.prompt_tokens
          smState.toolCallsSinceUpdate += turnToolCalls
          smState.lastTurnHadToolCalls = turnToolCalls > 0
          turnToolCalls = 0
          atTurnStart = true // 内层 turn 结束，下一内层 turn 开始前归零
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

    // 记忆提取：每轮末 fire-and-forget（不等待，不阻断 UI）
    extractor.onTurnEnd({ messages, turnIds: messages.map(m => turnOf.get(m)), maxTurnId: currentTurnId })

    // SessionMemory：达阈值时 fire-and-forget 更新 summary.md（不阻断 UI）
    if (mem.enabled && mem.sessionMemory.enabled && shouldUpdateSessionMemory(smState, mem.sessionMemory)) {
      const sid = ctx.sessionId?.()
      if (sid) {
        const smPath = sessionMemoryPathFor(cwd, sid, os.homedir())
        void runSessionMemoryUpdate({ client: opts.client, model, absPath: smPath, ctx, runSubagent: opts.runSubagent, onUsage: memoryOnUsage })
        smState.tokensAtLastUpdate = smState.promptTokens
        smState.initialized = true
        smState.toolCallsSinceUpdate = 0
      }
    }

    // autoDream：满门控（24h/5会话/锁）时后台合并记忆，作后台任务带通知
    if (mem.enabled && mem.dream.enabled) {
      const now = Date.now()
      const sessionsDir = path.join(os.homedir(), '.deepcode', 'sessions')
      const dreamProjectKey = sanitizeProjectKey(findGitRoot(cwd) ?? path.resolve(cwd))
      let dreamTaskId: string | undefined
      void runAutoDream({
        client: opts.client, model, memdir: memdirFor(cwd),
        sessionsDir, currentSessionFile: session.file,
        projectKey: dreamProjectKey,
        cfg: mem.dream, ctx, now, lastScanAt: dreamLastScanAt,
        runSubagent: opts.runSubagent, onUsage: memoryOnUsage,
        onStart: () => {
          const taskId = generateTaskId('local_agent')
          dreamTaskId = taskId
          registerTask({
            id: taskId, type: 'local_agent', status: 'running',
            description: '记忆整理（dream）',
            startTime: now, outputFile: '', outputOffset: 0, notified: false,
          })
        },
        onDone: (changed) => {
          if (!dreamTaskId) return
          updateTask(dreamTaskId, { status: changed ? 'completed' : 'failed', endTime: Date.now() })
          const t = getTask(dreamTaskId)
          if (t && changed) enqueueNotification(t)
        },
      })
      dreamLastScanAt = now
    }

    // 自动 compact（落盘之后；busy 保持 true 直到 compact 结束）
    // 发送前预估：上次真实 prompt_tokens + 自 baseline 以来新增消息的估算（含本轮 assistant 产出）。
    // clamp Math.min 守 rewind/截断（baselineLen 可能 > 当前 messages.length）。
    const estimated = lastPromptTokens + estimateMessagesTokens(messages.slice(Math.min(baselineLen, messages.length)))
    const thr = effectiveThreshold(model, settings.compactTokens)
    if (shouldAutoCompact(estimated, thr, consecutiveCompactFailures, MAX_AUTO_COMPACT_FAILURES)) {
      try { await doCompact('auto'); consecutiveCompactFailures = 0 }
      catch (e: any) {
        consecutiveCompactFailures++
        if (consecutiveCompactFailures >= MAX_AUTO_COMPACT_FAILURES) notice('warn', '自动压缩连续失败 3 次，已暂停（用 /compact 手动重试）')
        else notice('error', `[自动 compact 失败，将在下轮重试] ${e?.message ?? e}`)
      }
    }
    busy = false
    turnStartAt = null
    setState()
    refreshStatusLine() // 5.7 turn 结束触发 statusLine 刷新
    // 收尾自检：若某后台任务在本轮终止点 drain 之后、busy 复位之前完成入队，会滞留队列；
    // 此处 busy 已 false，重新唤醒一次把滞留通知补上（无则即返），避免拖到下次用户输入。
    wakeOnNotification()
  }

  /** 空闲唤醒：后台任务完成通知到达且当前 idle 时，drain 通知作为 user 消息自动跑一轮，
   *  让模型据完成情况决策。busy 时不抢——此刻 runLoop 终止点（injectTaskNotifications）会 drain 注入。
   *  busy 守卫天然防重入：唤醒触发的 runTurn 会置 busy，期间再来的通知不重复触发。 */
  const wakeOnNotification = (): void => {
    if (busy) return
    const notes = drainNotifications()
    if (notes.length === 0) return
    const text = notes.map(formatNotification).join('\n')
    void runTurn('（后台任务完成通知）', text)
  }
  const unsubNotification = onNotification(wakeOnNotification)

  const applyModel = (id: string): void => {
    model = id
    const known = belongsToProvider(activeProvider(), id)
    const suffix = known ? '' : '（非当前 provider 档，计价/上下文按兜底估算）'
    session.appendMeta({ cwd, model, providerId: activeProvider().id, thinking, effortLevel, permMode })
    notice('info', `已切换到 ${model}${suffix}`)
    setState()
  }

  /** 斜杠命令本地处理（/resume 由 UI 走 resumeList/resume，/exit 归 UI） */
  const send = async (line: string, attachments?: Attachment[]): Promise<void> => {
    line = line.trim()
    if (!line || busy) return
    line = attachments?.some(a => a.type === 'image')
      ? await resolveAttachments(line, attachments, {
          onStep: (id) => dispatch({ type: 'push', item: { kind: 'tool', id: `img-${id}`, name: '识别图片', desc: `#${id} · glm-4.6v`, running: false, ok: true } }),
          onError: (msg) => notice('warn', msg),
        })
      : expandTextAttachments(line, attachments)
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
        applyModel(arg)
      } else {
        // /model 无参：TUI 经 App.submit 拦截走 picker；此处为 headless/兜底，保留 fast↔smart 轮换
        model = rotateModel(model, activeProvider())
        session.appendMeta({ cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id })
        notice('info', `已切换到 ${model}`)
      }
      refreshStatusLine() // 5.7 模型变化触发 statusLine 刷新
      return
    }
    if (line === '/think') {
      thinking = !thinking
      session.appendMeta({ cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id })
      notice('info', `thinking 模式：${thinking ? '开' : '关'}`)
      return
    }
    if (line.startsWith('/effort')) {
      const arg = line.slice('/effort'.length).trim().toLowerCase()
      if (arg === 'off') {
        thinking = false
        session.appendMeta({ cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id })
        notice('info', 'thinking 模式：关')
      } else if (arg === 'low' || arg === 'medium' || arg === 'high') {
        effortLevel = arg
        thinking = true
        session.appendMeta({ cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id })
        notice('info', `思考档位：${arg}（thinking 开）`)
      } else {
        notice('info', `当前思考档位：${thinking ? effortLevel : 'off'}。用法：/effort low|medium|high|off`)
      }
      setState()
      return
    }
    if (line === '/accept') {
      if (opts.yolo) { notice('info', '当前是 yolo 模式，所有操作均已放行'); return }
      permMode = permMode === 'acceptEdits' ? 'default' : 'acceptEdits'
      session.appendMeta({ cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id })
      notice('info', `acceptEdits 模式：${permMode === 'acceptEdits' ? '开（Edit/Write 免确认，Bash 仍需确认）' : '关'}`)
      refreshStatusLine() // 5.7 权限模式变化触发 statusLine 刷新
      return
    }
    if (line === '/cycle-mode') {
      // Shift+Tab 用：default → acceptEdits → plan → default 三态循环（绝对定模式，回得到 default）。
      if (opts.yolo) return // yolo 仅 --yolo 启动，不参与循环
      if (permMode === 'default') permMode = 'acceptEdits'
      else if (permMode === 'acceptEdits') { prePlanMode = permMode; permMode = 'plan' } // 记进入前模式供 /plan 退出恢复（cycle 的 plan→default 走下一分支不读 prePlanMode）
      else { permMode = 'default'; prePlanMode = 'default' } // plan → default
      session.appendMeta({ cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id })
      notice('info', permMode === 'plan'
        ? 'plan 模式：只读探索 + 写计划，完成后调用 ExitPlanMode 请审批'
        : `已切换到 ${permMode} 模式`)
      refreshStatusLine() // 5.7 权限模式变化触发 statusLine 刷新
      return
    }
    if (line === '/plan') {
      if (opts.yolo) { notice('info', '当前是 yolo 模式，所有操作均已放行，无需 plan 模式'); return }
      if (permMode === 'plan') {
        // 退出 plan 模式：恢复进入前的模式
        permMode = prePlanMode
        session.appendMeta({ cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id })
        notice('info', `plan 模式已关闭，已恢复 ${permMode} 模式`)
      } else {
        // 进入 plan 模式：记录当前模式供退出时恢复
        prePlanMode = permMode
        permMode = 'plan'
        session.appendMeta({ cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id })
        notice('info', 'plan 模式已开启：只读探索 + 写计划，完成后调用 ExitPlanMode 请用户审批（/plan 可退出）')
      }
      setState()
      refreshStatusLine() // 5.7 plan 模式变化触发 statusLine 刷新
      return
    }
    if (line.startsWith('/add-dir')) {
      const arg = line.slice('/add-dir'.length).trim()
      if (!arg) {
        notice('info', `当前附加目录：${additionalDirs.length ? additionalDirs.join(', ') : '（无）'}\n用法：/add-dir <路径>`)
        return
      }
      const resolved = path.resolve(cwd, arg)
      try {
        const stat = fs.statSync(resolved)
        if (!stat.isDirectory()) { notice('warn', `路径不是目录：${resolved}`); return }
      } catch {
        notice('warn', `路径不存在：${resolved}`)
        return
      }
      if (!additionalDirs.includes(resolved)) {
        additionalDirs = [...additionalDirs, resolved]
        notice('info', `已添加工作目录白名单：${resolved}`)
      } else {
        notice('info', `已在白名单中：${resolved}`)
      }
      return
    }
    if (line === '/cost') {
      const mainLog = usageLog.filter(u => u.kind !== 'memory')
      const inTok = mainLog.reduce((s, u) => s + u.usage.prompt_tokens, 0)
      const hitTok = mainLog.reduce((s, u) => s + u.usage.prompt_cache_hit_tokens, 0)
      const outTok = mainLog.reduce((s, u) => s + u.usage.completion_tokens, 0)
      const totalCost = sessionCost()
      const memCost = usageLog.filter(u => u.kind === 'memory').reduce(
        (s, u) => s + costCNY(u.model, u.usage.prompt_tokens, u.usage.prompt_cache_hit_tokens, u.usage.completion_tokens), 0)
      const memLine = memCost > 0 ? `（其中记忆 fork：¥${memCost.toFixed(6)}）` : ''
      notice('info', `本会话：输入 ${inTok}（缓存命中 ${hitTok}）出 ${outTok} | 估算花费 ¥${totalCost.toFixed(6)} ${memLine}`.trimEnd())
      return
    }
    if (line === '/compact') {
      busy = true
      setState()
      try { await doCompact('manual'); consecutiveCompactFailures = 0 } catch (e: any) { notice('error', `[compact 失败] ${e?.message ?? e}`) }
      busy = false
      setState()
      return
    }
    if (line === '/clear') {
      fireSessionEnd('clear') // 旧会话结束，先于新会话 SessionStart
      messages.length = 1 // 保留 system
      ctx.fileState.clear()
      compacted = false
      lastPromptTokens = 0
      baselineLen = 0
      compactWarned = false
      consecutiveCompactFailures = 0
      pendingSessionContext = null
      session = newSession({ cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id }, sessionDir)
      session.appendMessage(messages[0])
      checkpointer = createCheckpointer(checkpointStoreFor(session.file))
      taskList.bind(sessionIdFromFile(session.file))
      currentTitle = null
      nextTurnId = 1; currentTurnId = 0
      // 重建 extractor，重置游标（旧会话游标对新会话无效，防新会话首轮被静默跳过）
      extractor = createMemoryExtractor({
        client: opts.client, model, memdir: memdirFor(cwd), config: mem, ctx,
        runSubagent: opts.runSubagent, onUsage: memoryOnUsage,
      })
      smState = { promptTokens: 0, tokensAtLastUpdate: 0, initialized: false, toolCallsSinceUpdate: 0, lastTurnHadToolCalls: false }
      dispatch({ type: 'clear' })
      notice('info', '对话已清空，已开新会话文件（本会话花费累计保留）')
      fireSessionStart('clear')
      return
    }
    if (line === '/rename' || line.startsWith('/rename ')) {
      const name = line.slice('/rename'.length).trim()
      if (!name) { notice('info', `当前标题：${currentTitle ?? '（未命名）'}\n用法：/rename <名称>`); return }
      currentTitle = name
      session.appendTitle(name)
      notice('info', `会话已重命名为「${name}」`)
      return
    }
    if (line === '/fork') {
      const base = stripBranchSuffix(currentTitle ?? (() => {
        const fu = messages.find(m => m.role === 'user' && typeof m.content === 'string')
        return typeof fu?.content === 'string' ? fu.content.slice(0, 40) : '会话'
      })())
      const existingTitles = listSessions(cwd, sessionDir).map(s => s.preview)
      const forkTitle = nextBranchTitle(base, existingTitles)
      const forkMeta = { cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id, title: forkTitle }
      const newS = newSession(forkMeta, sessionDir)
      for (const m of messages) newS.appendMessage(m, turnOf.get(m))
      session = newS
      currentTitle = forkTitle
      checkpointer = createCheckpointer(checkpointStoreFor(session.file))
      taskList.bind(sessionIdFromFile(session.file))
      extractor = createMemoryExtractor({
        client: opts.client, model, memdir: memdirFor(cwd), config: mem, ctx,
        runSubagent: opts.runSubagent, onUsage: memoryOnUsage,
      })
      smState = { promptTokens: 0, tokensAtLastUpdate: 0, initialized: false, toolCallsSinceUpdate: 0, lastTurnHadToolCalls: false }
      notice('info', `已分叉到新会话「${forkTitle}」（原会话保持不变；对话与花费继续，任务清单与文件检查点不随分叉带过）`)
      fireSessionStart('startup')
      return
    }
    if (line === '/context') {
      notice('info', formatContext(messages, usageLog[usageLog.length - 1]?.usage))
      return
    }
    if (line === '/export' || line.startsWith('/export ')) {
      const arg = line.slice('/export'.length).trim()
      const base = sessionIdFromFile(session.file ?? '')
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
    if (line === '/workflows') {
      const workflowDir = path.join(cwd, '.deepcode', 'workflows')
      try {
        const runIds = fs.readdirSync(workflowDir)
        if (runIds.length === 0) { notice('info', '（无 workflow 运行记录）'); return }
        const { formatWorkflowProgress } = await import('./WorkflowView.js')
        const lines: string[] = []
        for (const runId of runIds) {
          try {
            const raw = fs.readFileSync(path.join(workflowDir, runId, 'journal.jsonl'), 'utf8')
            const records = raw.split('\n').filter(Boolean).map(l => JSON.parse(l))
            const isDone = records.some((r: any) => r.type === 'workflow_complete')
            const s = formatWorkflowProgress(records, { id: runId, status: isDone ? 'completed' : 'running' })
            const phaseLine = s.phases.map(p => `  ${s.done ? '✓' : '⟳'} ${p.title} · ${p.agents} agents`).join('\n')
            const footer = s.done ? `Completed in ${(s.ms / 1000).toFixed(1)}s · ${s.agents} agents` : '（进行中）'
            lines.push([s.name || s.runId || runId, phaseLine, footer].filter(Boolean).join('\n'))
          } catch { /* skip */ }
        }
        notice('info', lines.length ? lines.join('\n\n') : '（无有效 workflow 记录）')
      } catch { notice('info', '（无 workflow 运行记录）') }
      return
    }
    if (line === '/memory') {
      notice('info', formatMemory(findMemoryFiles(cwd), os.homedir()))
      return
    }
    if (line === '/config') {
      const { loadLayeredSettings } = await import('../settingsLayers.js')
      const { formatConfigReport } = await import('../configReport.js')
      notice('info', formatConfigReport(loadLayeredSettings(cwd, opts.flagSettingsPath)))
      return
    }
    if (line === '/permissions' || line.startsWith('/permissions ')) {
      const arg = line.slice('/permissions'.length).trim()
      const allowList = settings.permissions.allow
      const denyList = resolveDenyList(settings.permissions.deny)
      const rmMatch = arg.match(/^rm\s+(\d+)$/)
      const denyRmMatch = arg.match(/^deny-rm\s+(\d+)$/)
      if (rmMatch) {
        const r = resolveRuleRemoval(allowList, Number(rmMatch[1]), ruleSources, 'user')
        if (r.ok) {
          removeUserAllowRuleByValue(r.value)
          const mem = settings.permissions.allow.indexOf(r.value)
          if (mem >= 0) settings.permissions.allow.splice(mem, 1)
          notice('info', `已删除：${r.value}`)
          fireConfigChange()
        } else notice('warn', r.reason)
      } else if (denyRmMatch) {
        const r = resolveRuleRemoval(denyList, Number(denyRmMatch[1]), denySources, 'builtin')
        if (r.ok) {
          removeUserDenyRuleByValue(r.value)
          if (settings.permissions.deny) {
            const mem = settings.permissions.deny.indexOf(r.value)
            if (mem >= 0) settings.permissions.deny.splice(mem, 1)
          }
          notice('info', `已删除 Deny：${r.value}`)
          fireConfigChange()
        } else notice('warn', r.reason)
      } else {
        notice('info', formatPermissionRules(allowList, ruleSources, denyList, denySources))
      }
      return
    }

    if (line === '/commit') {
      if (runBang('git rev-parse --is-inside-work-tree', cwd).code !== 0) {
        notice('warn', '当前目录不是 git 仓库')
        return
      }
      if (isEmptyDiff(runBang('git status --porcelain', cwd).output)) {
        notice('info', '没有可提交的改动')
        return
      }
      const status = runBang('git status', cwd).output
      const diff = runBang('git diff HEAD', cwd).output
      const branch = runBang('git branch --show-current', cwd).output
      const log = runBang('git log --oneline -10', cwd).output
      const ctxMsg = { role: 'user' as const, content: buildCommitContext({ status, diff, branch, log }) }
      messages.push(ctxMsg)
      session.appendMessage(ctxMsg)
      await runTurn(line, COMMIT_GUIDANCE)
      return
    }

    if (line === '/commit-push-pr') {
      if (runBang('git rev-parse --is-inside-work-tree', cwd).code !== 0) {
        notice('warn', '当前目录不是 git 仓库')
        return
      }
      if (isEmptyDiff(runBang('git status --porcelain', cwd).output)) {
        notice('info', '没有可提交的改动')
        return
      }
      const status = runBang('git status', cwd).output
      const diff = runBang('git diff HEAD', cwd).output
      const branch = runBang('git branch --show-current', cwd).output
      const base = resolveBaseBranch(cwd)
      const baseDiff = runBang(`git diff ${base}...HEAD`, cwd).output
      const existingPr = runBang('gh pr view --json number 2>/dev/null || true', cwd).output
      const ctxMsg = { role: 'user' as const, content: buildPrContext({ status, diff, branch, baseDiff, existingPr }) }
      messages.push(ctxMsg)
      session.appendMessage(ctxMsg)
      await runTurn(line, COMMIT_PUSH_PR_GUIDANCE)
      return
    }

    // 斜杠命令：/init、skill 命令、自定义命令；未知则报错
    let userText = line
    if (line === '/init') {
      userText = INIT_PROMPT
    } else if (line.startsWith('/')) {
      const [name, ...rest] = line.slice(1).split(' ')
      const skill = skills.find(s => s.name === name && s.userInvocable)
      if (skill) {
        // skill 命中：填充参数后作为 user 指令发送（forked/inline 统一走 user 路径，无 tool_call 上下文）
        // forked 用户技能简化：斜杠路径无法注入 tool_call 上下文，inline 化（注偏离：forked 不隔离子 agent）
        if (skill.context === 'fork') {
          notice('info', `技能 /${name} 为 fork 类型，斜杠调用按 inline 处理（不隔离子代理）`)
        }
        const args = rest.join(' ')
        const filled = substituteSkillArgs(skill.body, args, {
          argNames: skill.argNames, skillDir: skill.skillDir, sessionId: ctx.sessionId?.(),
        })
        userText = filled
      } else {
        const tpl = customCommands.get(name)
        if (!tpl) { notice('warn', `未知命令 /${name}，/help 查看可用命令`); return }
        userText = expandCommand(tpl, rest.join(' '))
      }
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

  const applyOutputStyle = (name: string): void => {
    outputStyleName = name
    const style = resolveOutputStyle(name, outputStyleCache)
    const rebuilt = buildSystemPrompt(cwd, undefined, skills, settings.skills?.listingBudgetChars, memdir, style)
    if (messages[0]?.role === 'system') messages[0] = { role: 'system', content: rebuilt }
    else messages.unshift({ role: 'system', content: rebuilt })
    try { const raw = loadRawUserSettings(); raw.outputStyle = name; saveRawUserSettings(raw) } catch { /* 持久化失败不阻断热切 */ }
    notice('info', `输出风格：${name}`)
    setState()
  }

  const outputStyleList = (): { name: string; description: string }[] => [
    { name: 'default', description: '默认（不额外注入风格）' },
    ...outputStyleCache.map(s => ({ name: s.name, description: s.description })),
  ]

  // 5.7 会话建立后跑一次 statusLine（recovered 与新建两条路径都到这里）
  refreshStatusLine()

  return {
    get state() { return state },
    send,
    interrupt: () => {
      // 若权限弹窗挂起（pendingAsk），checkPermission 内的 ask Promise 永不 resolve，
      // generator 永不返回，busy 永远 true——必须先拒绝掉再 abort，否则死锁。
      if (pendingAsk) { const p = pendingAsk; pendingAsk = null; setState(); p.resolve('no') }
      if (pendingQuestion) { const p = pendingQuestion; pendingQuestion = null; setState(); p.resolve(null) }
      if (pendingPlanApproval) { const p = pendingPlanApproval; pendingPlanApproval = null; setState(); p.resolve(false) }
      compactAbort?.abort('user-cancel') // 压缩进行中：ESC 也能中断（否则卡在 doCompact 的 ac，永远逃不出）
      abort.abort('user-cancel')
    },
    steer: (text: string, attachments?: Attachment[]) => {
      if (!text.trim()) return
      const resolved = expandTextAttachments(text, attachments)  // 入队前展开（CC：队列存完整文本；图片在 steer 路径不做识别）
      steerQueue.enqueue(resolved, 'next') // 用户路径恒 next（CC 模型：toolInFlight 时自动软中断）
      if (toolsRunning > 0) abort.abort('interrupt') // 有 tool 在跑：软中断当前 turn，loop 据 reason 续跑
    },
    steerPop: () => steerQueue.popLast()?.value,
    steerQueue: () => steerQueue.peek(),
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
    resolvePlanApproval: (approved: boolean) => {
      if (!pendingPlanApproval) return
      const p = pendingPlanApproval
      pendingPlanApproval = null
      if (approved) {
        // 退出 plan 模式，恢复进入前的模式
        permMode = prePlanMode
        session.appendMeta({ cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id })
        // allowedPrompts → Bash 规则（仿 saveRule 机制，前缀形式 Bash(<prompt>:*)）
        for (const ap of (p.allowedPrompts ?? [])) {
          const rule = `Bash(${ap.prompt}:*)`
          addUserAllowRule(rule)
          if (!settings.permissions.allow.includes(rule)) settings.permissions.allow.push(rule)
          ruleSources[rule] = 'user'
        }
        if ((p.allowedPrompts ?? []).length > 0) fireConfigChange()
        notice('info', `计划已批准，已退出 plan 模式（恢复 ${permMode} 模式）`)
      }
      setState()
      p.resolve(approved)
    },
    resumeList: () => listSessions(cwd, sessionDir).slice(0, 10).map(s => ({ file: s.file, preview: s.preview })),
    resume: (file: string) => {
      if (busy) return
      const turns = restoreSession(file)
      // 换会话时重建 extractor，重置游标（上一会话的游标对新会话无效）
      extractor = createMemoryExtractor({
        client: opts.client, model, memdir: memdirFor(cwd), config: mem, ctx,
        runSubagent: opts.runSubagent, onUsage: memoryOnUsage,
      })
      smState = { promptTokens: 0, tokensAtLastUpdate: 0, initialized: false, toolCallsSinceUpdate: 0, lastTurnHadToolCalls: false }
      dispatch({ type: 'clear' }) // 换了会话，旧 transcript 不再对应当前 messages
      notice('info', `已恢复会话（${turns} 轮对话）`)
      fireSessionStart('resume')
    },
    customCommands,
    skills,
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
    getCwd: () => cwd,
    dispose: () => { fireSessionEnd('exit'); unsubNotification(); unsubSteer(); steerQueue.clear(); statusLineRunner?.dispose(); void mcpCleanup?.() },
    modelList: () => providerModelList(activeProvider(), model),
    applyModel,
    outputStyleList,
    applyOutputStyle,
  }
}

export function useChat(core: ChatCore): ChatState {
  return useSyncExternalStore(core.subscribe, () => core.state)
}
