// src/backgroundRunner.ts
// 7.3：/background detached 子进程的运行器。resume 会话续跑 + 持久化 + job 状态机。
import path from 'node:path'
import type OpenAI from 'openai'
import { runLoop } from './loop.js'
import { resolveAgents } from './agentsLoader.js'
import { installTaskCleanup } from './tasks.js'
import { buildSystemPrompt } from './prompt.js'
import { loadOutputStyles, resolveOutputStyle } from './outputStyles.js'
import { loadLayeredSettings } from './settingsLayers.js'
import { runHooks } from './hooks.js'
import { makeHookRuntime } from './hookRuntime.js'
import { initMcpTools } from './mcp.js'
import { loadSkills } from './skillsLoader.js'
import { TaskListStore } from './taskList.js'
import { resolveDenyList, buildDenySourceMap } from './deny.js'
import { activeFastModel } from './providers.js'
import { loadSession, openSession, sessionIdFromFile } from './session.js'
import { updateJobState } from './backgroundSession.js'
import { buildHeadlessToolset } from './headless.js'
import type { ToolContext, WorktreeSessionState } from './tools/types.js'
import type { Usage } from './api.js'

export async function runBackgroundSession(opts: {
  client: OpenAI; resumeFile: string; jobShort: string
  seed?: string; yolo?: boolean; permMode?: string; model?: string; flagSettingsPath?: string
}): Promise<void> {
  process.env.DEEPCODE_SESSION_KIND = 'bg'
  installTaskCleanup()

  // SIGTERM（/stop 杀）→ 标 stopped 后退出
  const onTerm = () => { updateJobState(opts.jobShort, { state: 'stopped', updatedAt: Date.now() }); process.exit(0) }
  process.on('SIGTERM', onTerm)

  const loaded = loadSession(opts.resumeFile)
  const layered = loadLayeredSettings(loaded.meta.cwd || process.cwd(), opts.flagSettingsPath)
  const settings = layered.settings
  const denySources = buildDenySourceMap(layered.permissionSources.deny)
  const model = opts.model ?? loaded.meta.model ?? settings.model ?? activeFastModel()
  let cwd = loaded.meta.cwd || process.cwd()
  const agents = resolveAgents(cwd)
  const skills = loadSkills(cwd, undefined, settings.skills)
  const injectionBuffer: string[] = []
  const taskList = new TaskListStore()
  const sessionId = sessionIdFromFile(opts.resumeFile)
  taskList.bind(sessionId)
  const handle = openSession(opts.resumeFile)
  let worktreeState: WorktreeSessionState | null = null
  const ctx: ToolContext = {
    cwd: () => cwd,
    setCwd: d => { cwd = d },
    denyPatterns: () => resolveDenyList(settings.permissions.deny),
    signal: new AbortController().signal,
    fileState: new Map(loaded.fileState),
    taskList,
    hookDispatch: (event, payload) => runHooks(event, payload, settings.hooks),
    sessionId: () => sessionId,
    injectUserMessage: (c: string) => injectionBuffer.push(c),
    worktreeSession: { get: () => worktreeState, set: s => { worktreeState = s } },
    worktreeConfig: () => settings.worktree,
  }
  const total: Usage = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 }
  const addUsage = (u: Usage) => {
    total.prompt_tokens += u.prompt_tokens; total.completion_tokens += u.completion_tokens; total.prompt_cache_hit_tokens += u.prompt_cache_hit_tokens
  }
  const hookDeps = {
    ...makeHookRuntime({ client: opts.client, getModel: () => model, onUsage: (u, _m) => addUsage(u), cwd: () => cwd }),
    allowedHttpHookUrls: settings.allowedHttpHookUrls,
    httpHookAllowedEnvVars: settings.httpHookAllowedEnvVars,
  }
  ctx.hookDispatch = (event, payload) => runHooks(event, payload, settings.hooks, hookDeps)

  // resume：用已存消息续跑；若无 system 头则补一条（防空会话）
  const messages: any[] = loaded.messages.length
    ? [...loaded.messages]
    : [{ role: 'system', content: buildSystemPrompt(cwd, undefined, skills, settings.skills?.listingBudgetChars, undefined, resolveOutputStyle(settings.outputStyle, loadOutputStyles())) }]
  // seed prompt → 追加 user 消息并落盘（无 seed 时续跑未完回合，reply-on-resume）
  if (opts.seed) {
    const um = { role: 'user', content: opts.seed }
    messages.push(um)
    handle.appendMessage(um, loaded.maxTurnId + 1)
  }

  const { tools: mcpTools, cleanup: mcpCleanup } = await initMcpTools(settings.mcpServers, { onWarn: msg => process.stderr.write(msg + '\n') })
  const lenBefore = messages.length
  const gen = runLoop(messages, {
    client: opts.client,
    tools: buildHeadlessToolset({ client: opts.client, addUsage, getModel: () => model, agents, settings, cwd, skills, mcpTools }),
    model,
    thinking: false,
    maxToolResultChars: settings.maxToolResultChars,
    ctx,
    permission: {
      mode: opts.yolo ? 'yolo' : (opts.permMode as any) || 'default',
      rules: settings.permissions.allow,
      deny: resolveDenyList(settings.permissions.deny),
      cwd,
      saveRule: () => {},
      ask: async () => 'no', // 后台无人值守：默认拒绝，理由喂回模型
      ruleSources: layered.permissionSources.allow,
      denySources,
    },
    reminders: () => { taskList.tick(); const n = taskList.staleReminder(); return n ? [n] : [] },
    drainInjections: () => injectionBuffer.splice(0),
    injectTaskNotifications: true,
    hooks: settings.hooks,
    hookDeps,
  })
  try {
    let step
    while (!(step = await gen.next()).done) { const ev = step.value; if (ev.type === 'turn_end') addUsage(ev.usage) }
    // 落盘本轮新增消息 + fileState 快照
    for (const m of messages.slice(lenBefore)) handle.appendMessage(m)
    handle.appendFileState([...ctx.fileState])
    updateJobState(opts.jobShort, { state: 'completed', updatedAt: Date.now() })
  } catch (e) {
    try { for (const m of messages.slice(lenBefore)) handle.appendMessage(m) } catch {}
    updateJobState(opts.jobShort, { state: 'failed', updatedAt: Date.now() })
  } finally {
    process.off('SIGTERM', onTerm)
    await mcpCleanup()
  }
}
