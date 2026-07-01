// src/backgroundSession.ts
// 7.3 后台会话薄片：job 状态模型 + 落盘/枚举/格式化。纯逻辑，无 TUI 依赖。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

export type JobStatus = 'working' | 'completed' | 'failed' | 'stopped'

export interface JobState {
  sessionId: string       // forked 会话 id（= sessionFile basename 去 .jsonl）
  short: string           // sessionId[:8]，job 目录名
  state: JobStatus
  cwd: string
  name: string            // 会话标题 / seed 首句，供列表展示
  initialPrompt?: string  // seed prompt（可空=续跑未完回合）
  pid: number             // detached 子进程 pid（供 /stop 杀；父进程 spawn 后回填）
  model: string
  permMode: string
  sessionFile: string     // forked JSONL 绝对路径（供 /resume 回看）
  backend: 'detached'
  createdAt: number
  updatedAt: number
}

/** 测试可用 DEEPCODE_TEST_HOME 覆盖 home，避免污染真实 ~/.deepcode/jobs。 */
function jobsRoot(): string {
  const home = process.env.DEEPCODE_TEST_HOME || os.homedir()
  return path.join(home, '.deepcode', 'jobs')
}

/** sessionId → 8 位 hex 短 id（job 目录名）。deepcode sessionId 是时间戳文件名（如
 *  2026-07-01T10-17-08-545Z-g0x1），同月/同日的多个会话共享字符串前缀，故不能直接 slice(0,8)
 *  （曾撞车：CC 移植遗留，CC 的 sessionId 是 UUID 才能安全 slice）。改用 sha256 哈希摘要，
 *  避免不同 sessionId 撞到同一 job 目录。 */
export function shortId(sessionId: string): string {
  return crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 8)
}

export function jobStateDir(short: string): string {
  return path.join(jobsRoot(), short)
}

function stateFile(short: string): string {
  return path.join(jobStateDir(short), 'state.json')
}

export function writeJobState(s: JobState): void {
  fs.mkdirSync(jobStateDir(s.short), { recursive: true })
  fs.writeFileSync(stateFile(s.short), JSON.stringify(s), { mode: 0o600 })
}

export function readJobState(short: string): JobState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile(short), 'utf8')) as JobState
  } catch { return null }
}

export function updateJobState(short: string, patch: Partial<JobState>): JobState | null {
  const cur = readJobState(short)
  if (!cur) return null
  const next = { ...cur, ...patch }
  writeJobState(next)
  return next
}

export function listJobs(): JobState[] {
  let dirs: string[]
  try { dirs = fs.readdirSync(jobsRoot()) } catch { return [] }
  const out: JobState[] = []
  for (const d of dirs) {
    const j = readJobState(d)
    if (j) out.push(j)
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** pid 是否存活：kill(pid, 0) 不发信号只探活。EPERM=进程在但非我方所有→按存活处理；
 *  ESRCH（含 pid<=0 的非法态）→ 已死。用于兜底 detached 子进程被杀/OOM 却没走到 catch 的僵尸 job。 */
export function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e?.code === 'EPERM'
  }
}

/** 读侧兜底：working 但 pid 已死 → 判定 failed 并落盘。listJobs() 本身保持纯（测试依赖其不做存活判定），
 *  校正只在这里做。供 /stop、resumeList、启动清理复用。 */
export function reconcileJobs(now: number): JobState[] {
  return listJobs().map(j => {
    if (j.state === 'working' && j.pid > 0 && !isPidAlive(j.pid)) {
      return updateJobState(j.short, { state: 'failed', updatedAt: now }) ?? j
    }
    return j
  })
}

export function formatJobList(jobs: JobState[], now: number): string {
  if (jobs.length === 0) return '（无后台会话）'
  return jobs.map(j => {
    const age = Math.max(0, Math.round((now - j.createdAt) / 1000))
    return `${j.short}  [${j.state}]  ${j.name}  · ${j.cwd} · ${age}s 前`
  }).join('\n')
}

/** 删除超龄的终态 job（working 永不删）。启动时调一次。 */
export function cleanupOldJobs(maxAgeMs: number, now: number): void {
  for (const j of listJobs()) {
    if (j.state === 'working') continue
    if (now - j.updatedAt > maxAgeMs) {
      fs.rmSync(jobStateDir(j.short), { recursive: true, force: true })
    }
  }
}

/** 构造 detached 子进程 argv（纯函数，供 /background spawn 用）。 */
export function buildBackgroundArgv(a: {
  entry: string; resumeFile: string; short: string
  seed?: string; permMode?: string; model?: string
}): string[] {
  return [
    a.entry, '--background-run', '--resume', a.resumeFile, '--job', a.short,
    ...(a.seed ? ['-p', a.seed] : []),
    ...(a.permMode ? ['--permission-mode', a.permMode] : []),
    ...(a.model ? ['--model', a.model] : []),
  ]
}
