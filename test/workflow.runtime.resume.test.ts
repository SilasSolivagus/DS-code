// test/workflow.runtime.resume.test.ts
// 多 stage pipeline 在并发完成顺序错位（timing skew）下的 resume 缓存稳定性。
import { describe, it, expect, vi } from 'vitest'
import { createRuntime } from '../src/workflow/runtime.js'
import type { JournalRecord } from '../src/workflow/types.js'

// 后端：stage1 调用按「逆序」结算（item c 最快、a 最慢）→ stage2 的 agent() 进入顺序被打乱。
// 结果与 prompt 绑定，保证各 item 的 stage2 prompt 互不相同。
function skewBackend() {
  const delayFor = (prompt: string) => {
    if (prompt.startsWith('s1:')) {
      const ch = prompt.slice(3) // a|b|c
      return ch === 'a' ? 30 : ch === 'b' ? 20 : 10 // 逆序结算
    }
    return 0
  }
  return vi.fn((spec: { prompt: string }) =>
    new Promise(res => setTimeout(() => res({ status: 'ok', result: 'R(' + spec.prompt + ')' }), delayFor(spec.prompt))),
  )
}

function deps(over: any = {}) {
  return {
    backend: { runAgent: skewBackend() },
    journal: { append: vi.fn().mockResolvedValue(undefined) },
    records: [] as JournalRecord[],
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    onProgress: () => {},
    abortSignal: new AbortController().signal,
    ...over,
  }
}

// 直接驱动 runtime.pipeline（绕过 vm 沙箱），等价于脚本：
//   pipeline(['a','b','c'], x => agent('s1:'+x), x => agent('s2:'+x))
async function runPipeline(rt: ReturnType<typeof createRuntime>) {
  return rt.pipeline(['a', 'b', 'c'],
    (x: unknown) => rt.agent('s1:' + x),
    (x: unknown) => rt.agent('s2:' + x))
}

describe('多 stage pipeline 并发 timing-skew 下的 resume', () => {
  it('录制一次后用同样 records 重跑 → 每个 agent() 命中缓存，backend 0 次', async () => {
    // —— 录制运行：捕获 journal 记录 ——
    const captured: JournalRecord[] = []
    const d1 = deps({ journal: { append: vi.fn(async (r: JournalRecord) => { captured.push(r) }) } })
    const rt1 = createRuntime(d1 as any)
    const out1 = await runPipeline(rt1)
    expect(out1).toEqual(['R(s2:R(s1:a))', 'R(s2:R(s1:b))', 'R(s2:R(s1:c))'])
    // 6 次 agent（3 item × 2 stage）全部实跑
    expect(d1.backend.runAgent).toHaveBeenCalledTimes(6)

    // —— 重跑：预载录制记录，backend 应一次都不被调 ——
    const d2 = deps({ records: captured })
    const rt2 = createRuntime(d2 as any)
    const out2 = await runPipeline(rt2)
    expect(out2).toEqual(out1)
    expect(d2.backend.runAgent).toHaveBeenCalledTimes(0)
  })
})
