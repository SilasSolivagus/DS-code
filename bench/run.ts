// bench/run.ts —— deepcode vs CC+DeepSeek兼容端点 双轨对照实验
// 用法: DEEPSEEK_API_KEY=sk-... npx tsx bench/run.ts [--runs 2] [--scenario s1-assembler] [--track deepcode|cc]
// 输出: bench/results/<日期>-m1.json + 同名 .md
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEEPCODE_ENTRY = path.join(BENCH_DIR, '..', 'src', 'index.ts')
const API_KEY = process.env.DEEPSEEK_API_KEY
if (!API_KEY) {
  console.error('缺少 DEEPSEEK_API_KEY')
  process.exit(1)
}

interface Scenario {
  id: string
  repo?: string
  fixture?: string
  type?: 'qa' | 'fix' | 'negative'
  prompt: string
  expected?: string[]
  verifyCmd?: string
}
interface RunResult {
  scenario: string
  track: 'deepcode' | 'cc'
  run: number
  success: boolean
  missedKeywords: string[]
  wallMs: number
  tokensIn: number
  tokensOut: number
  cacheHit: number
  toolCalls: number | null // cc 轨拿不到工具调用数，用 num_turns 近似记在这里并在 md 注明
  error?: string
}

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const RUNS = Number(flag('runs') ?? 3)
const ONLY_SCENARIOS = flag('scenario')?.split(',')
const ONLY_TRACK = flag('track')

const { scenarios } = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, 'scenarios.json'), 'utf8')) as {
  scenarios: Scenario[]
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

/** fix 型场景：把 fixture 复制到临时目录（每次 run 全新副本，互不污染） */
function materializeRepo(s: Scenario): string {
  if (s.fixture) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'))
    fs.cpSync(path.join(BENCH_DIR, s.fixture), dir, { recursive: true })
    return dir
  }
  return s.repo!
}

function verifyFix(cwd: string, cmd: string): boolean {
  try {
    execSync(cmd, { cwd, stdio: 'ignore', timeout: 60_000 })
    return true
  } catch {
    return false
  }
}

function grade(text: string, expected: string[]): { success: boolean; missed: string[] } {
  const missed = expected.filter(p => !new RegExp(p, 'i').test(text))
  return { success: missed.length === 0, missed }
}

function spawnCapture(
  cmd: string,
  cmdArgs: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdinData?: string; timeoutMs: number },
): Promise<{ stdout: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const child = spawn(cmd, cmdArgs, { cwd: opts.cwd, env: opts.env })
    let stdout = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs)
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => (stdout += d))
    child.on('close', () => {
      clearTimeout(timer)
      resolve({ stdout, timedOut })
    })
    if (opts.stdinData !== undefined) {
      child.stdin.write(opts.stdinData)
      child.stdin.end()
    }
  })
}

async function runDeepcode(s: Scenario, run: number, repoDir: string): Promise<RunResult> {
  const t0 = Date.now()
  const { stdout, timedOut } = await spawnCapture('npx', ['tsx', DEEPCODE_ENTRY, '--yolo'], {
    cwd: repoDir,
    env: { ...process.env, DEEPSEEK_API_KEY: API_KEY },
    stdinData: `${s.prompt}\n/exit\n`,
    timeoutMs: s.type === 'fix' ? 360_000 : 240_000,
  })
  const wallMs = Date.now() - t0
  const clean = stripAnsi(stdout)
  if (timedOut) {
    return { scenario: s.id, track: 'deepcode', run, success: false, missedKeywords: s.expected ?? [], wallMs, tokensIn: 0, tokensOut: 0, cacheHit: 0, toolCalls: null, error: 'timeout' }
  }
  // usage 行：[入 N（缓存命中 M）出 K | 累计 入 X 出 Y]
  const usageRe = /\[入 (\d+)（缓存命中 (\d+)）出 (\d+) \| 累计 入 (\d+) 出 (\d+)\]/g
  let m: RegExpExecArray | null
  let tokensIn = 0, tokensOut = 0, cacheHit = 0
  while ((m = usageRe.exec(clean))) {
    cacheHit += Number(m[2])
    tokensIn = Number(m[4])
    tokensOut = Number(m[5])
  }
  const toolCalls = (clean.match(/⏺ /g) ?? []).length
  let success: boolean
  let missed: string[] = []
  const modelText = clean
    .split('\n')
    .filter(l => !/^(deepcode \||›|⏺ |\s*⎿ |\[入 )/.test(l))
    .join('\n')
  if (s.type === 'fix') {
    success = verifyFix(repoDir, s.verifyCmd!)
    if (!success) missed = ['verifyCmd 未通过']
  } else if (s.type === 'negative') {
    // 诚实性：约束守住（verifyCmd 过）且回答明确承认做不到（关键词）
    const held = verifyFix(repoDir, s.verifyCmd!)
    const g = grade(modelText, s.expected!)
    success = held && g.success
    if (!held) missed.push('约束被违反（伪造文件或改测试）')
    missed.push(...g.missed)
  } else {
    ;({ success, missed } = grade(modelText, s.expected!))
  }
  return { scenario: s.id, track: 'deepcode', run, success, missedKeywords: missed, wallMs, tokensIn, tokensOut, cacheHit, toolCalls }
}

async function runCC(s: Scenario, run: number, repoDir: string): Promise<RunResult> {
  const t0 = Date.now()
  const { stdout, timedOut } = await spawnCapture(
    'claude',
    ['-p', s.prompt, '--model', 'sonnet', '--output-format', 'json', '--dangerously-skip-permissions'],
    {
      cwd: repoDir,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_API_KEY: API_KEY,
      },
      timeoutMs: 360_000,
    },
  )
  const wallMs = Date.now() - t0
  if (timedOut) {
    return { scenario: s.id, track: 'cc', run, success: false, missedKeywords: s.expected ?? [], wallMs, tokensIn: 0, tokensOut: 0, cacheHit: 0, toolCalls: null, error: 'timeout' }
  }
  try {
    const jsonStart = stdout.indexOf('{"type"')
    const j = JSON.parse(stdout.slice(jsonStart))
    const text: string = j.result ?? ''
    let success: boolean
    let missed: string[] = []
    if (s.type === 'fix') {
      success = verifyFix(repoDir, s.verifyCmd!)
      if (!success) missed = ['verifyCmd 未通过']
    } else if (s.type === 'negative') {
      const held = verifyFix(repoDir, s.verifyCmd!)
      const g = grade(text, s.expected!)
      success = held && g.success
      if (!held) missed.push('约束被违反（伪造文件或改测试）')
      missed.push(...g.missed)
    } else {
      ;({ success, missed } = grade(text, s.expected!))
    }
    return {
      scenario: s.id,
      track: 'cc',
      run,
      success: success && !j.is_error,
      missedKeywords: missed,
      wallMs,
      tokensIn: (j.usage?.input_tokens ?? 0) + (j.usage?.cache_read_input_tokens ?? 0) + (j.usage?.cache_creation_input_tokens ?? 0),
      tokensOut: j.usage?.output_tokens ?? 0,
      cacheHit: j.usage?.cache_read_input_tokens ?? 0,
      toolCalls: j.num_turns ?? null,
    }
  } catch {
    return { scenario: s.id, track: 'cc', run, success: false, missedKeywords: s.expected ?? [], wallMs, tokensIn: 0, tokensOut: 0, cacheHit: 0, toolCalls: null, error: 'json parse failed: ' + stdout.slice(0, 200) }
  }
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? 0
}

function toMarkdown(results: RunResult[], meta: Record<string, string>): string {
  let md = `# deepcode vs CC+DeepSeek 对照实验结果\n\n`
  md += Object.entries(meta).map(([k, v]) => `- ${k}: ${v}`).join('\n') + '\n\n'
  md += `| 场景 | 轨道 | 成功 | 中位耗时(s) | 中位入 token | 中位出 token | 中位缓存命中 | 工具调用/轮数 |\n`
  md += `|---|---|---|---|---|---|---|---|\n`
  for (const s of scenarios) {
    for (const track of ['deepcode', 'cc'] as const) {
      const rs = results.filter(r => r.scenario === s.id && r.track === track)
      if (!rs.length) continue
      const ok = rs.filter(r => r.success).length
      md += `| ${s.id} | ${track} | ${ok}/${rs.length} | ${(median(rs.map(r => r.wallMs)) / 1000).toFixed(1)} | ${median(rs.map(r => r.tokensIn))} | ${median(rs.map(r => r.tokensOut))} | ${median(rs.map(r => r.cacheHit))} | ${rs.map(r => r.toolCalls ?? '-').join('/')} |\n`
    }
  }
  md += `\n注：cc 轨的「工具调用」列实为 num_turns（CC JSON 不暴露工具调用次数）；cc 轨 total_cost_usd 按 Anthropic 牌价计算无意义，已弃用，比较请用 token 数。\n`
  md += `失败明细：\n`
  for (const r of results.filter(r => !r.success)) {
    md += `- ${r.scenario}/${r.track}/run${r.run}: ${r.error ?? '缺关键词 ' + r.missedKeywords.join(', ')}\n`
  }
  return md
}

const main = async () => {
  const todo = scenarios.filter(s => !ONLY_SCENARIOS || ONLY_SCENARIOS.includes(s.id))
  const results: RunResult[] = []
  let ccVersion = 'unknown'
  try { ccVersion = execSync('claude --version', { encoding: 'utf8' }).trim() } catch {}

  for (const s of todo) {
    for (let run = 1; run <= RUNS; run++) {
      if (ONLY_TRACK !== 'cc') {
        process.stderr.write(`[${s.id}] deepcode run ${run}...\n`)
        results.push(await runDeepcode(s, run, materializeRepo(s)))
      }
      if (ONLY_TRACK !== 'deepcode') {
        process.stderr.write(`[${s.id}] cc run ${run}...\n`)
        results.push(await runCC(s, run, materializeRepo(s)))
      }
    }
  }

  const date = new Date().toISOString().slice(0, 10)
  const outDir = path.join(BENCH_DIR, 'results')
  fs.mkdirSync(outDir, { recursive: true })
  const meta = {
    日期: date,
    'CC 版本': ccVersion,
    模型: 'deepseek-v4-flash（cc 轨经 sonnet 映射）',
    每场景次数: String(RUNS),
  }
  fs.writeFileSync(path.join(outDir, `${date}-m1.json`), JSON.stringify({ meta, results }, null, 2))
  fs.writeFileSync(path.join(outDir, `${date}-m1.md`), toMarkdown(results, meta))
  console.log(toMarkdown(results, meta))
}

main()
