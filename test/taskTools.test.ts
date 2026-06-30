// test/taskTools.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bgTaskListTool, taskOutputTool, taskStopTool } from '../src/tools/taskTools.js'
import {
  registerTask,
  getTask,
  clearAllTasks,
  type BackgroundTask,
} from '../src/tasks.js'
import type { ToolContext } from '../src/tools/types.js'

function ctx(): ToolContext {
  return {
    cwd: () => process.cwd(),
    setCwd: () => {},
    signal: new AbortController().signal,
    fileState: new Map(),
  }
}

function mkTask(over: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: over.id ?? 'b00000000',
    type: over.type ?? 'local_bash',
    status: over.status ?? 'running',
    description: over.description ?? 'echo hi',
    startTime: over.startTime ?? 1000,
    outputFile: over.outputFile ?? '/tmp/b00000000.log',
    outputOffset: over.outputOffset ?? 0,
    notified: over.notified ?? false,
    ...over,
  }
}

let tmpDir: string
beforeEach(() => {
  clearAllTasks()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskTools-'))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('bgTaskListTool', () => {
  it('列出所有后台任务（每行 id [status] description）', async () => {
    registerTask(mkTask({ id: 'b11111111', status: 'running', description: 'sleep 5' }))
    registerTask(mkTask({ id: 'a22222222', type: 'local_agent', status: 'completed', description: '查文档' }))
    const out = await bgTaskListTool.call({}, ctx())
    expect(out).toContain('b11111111 [running] sleep 5')
    expect(out).toContain('a22222222 [completed] 查文档')
  })

  it('空列表返回友好文案', async () => {
    const out = await bgTaskListTool.call({}, ctx())
    expect(out).toBe('（无后台任务）')
  })

  it('元数据：只读、无需权限', () => {
    expect(bgTaskListTool.isReadOnly).toBe(true)
    expect(bgTaskListTool.needsPermission({})).toBe(false)
  })
})

describe('taskOutputTool', () => {
  it('首次读返回全量 + status，并推进游标到文件末尾', async () => {
    const f = path.join(tmpDir, 'b1.log')
    fs.writeFileSync(f, 'hello world')
    registerTask(mkTask({ id: 'b1', status: 'running', outputFile: f, outputOffset: 0 }))
    const out = await taskOutputTool.call({ task_id: 'b1' }, ctx())
    expect(out).toBe('<status>running</status>\nhello world')
    expect(getTask('b1')!.outputOffset).toBe(Buffer.byteLength('hello world'))
  })

  it('第二次读只返回新增内容（增量）', async () => {
    const f = path.join(tmpDir, 'b2.log')
    fs.writeFileSync(f, 'AAA')
    registerTask(mkTask({ id: 'b2', status: 'running', outputFile: f, outputOffset: 0 }))
    await taskOutputTool.call({ task_id: 'b2' }, ctx())
    fs.appendFileSync(f, 'BBB')
    const out = await taskOutputTool.call({ task_id: 'b2' }, ctx())
    expect(out).toBe('<status>running</status>\nBBB')
    expect(getTask('b2')!.outputOffset).toBe(6)
  })

  it('显式 offset 从指定字节处读，不用游标', async () => {
    const f = path.join(tmpDir, 'b3.log')
    fs.writeFileSync(f, '0123456789')
    registerTask(mkTask({ id: 'b3', status: 'running', outputFile: f, outputOffset: 5 }))
    const out = await taskOutputTool.call({ task_id: 'b3', offset: 2 }, ctx())
    expect(out).toBe('<status>running</status>\n23456789')
  })

  it('输出文件不存在时返回空内容（chunk 为空）', async () => {
    registerTask(mkTask({ id: 'b4', status: 'running', outputFile: path.join(tmpDir, 'nope.log') }))
    const out = await taskOutputTool.call({ task_id: 'b4' }, ctx())
    expect(out).toBe('<status>running</status>\n')
  })

  it('任务不存在返回友好提示', async () => {
    const out = await taskOutputTool.call({ task_id: 'zzz' }, ctx())
    expect(out).toBe('任务 zzz 不存在')
  })

  it('无文件流输出但有 result（如 Workflow）→ 回退到 result', async () => {
    registerTask(mkTask({ id: 'w11111111', type: 'local_workflow', status: 'completed', outputFile: '', result: '{"summary":"done"}' }))
    const out = await taskOutputTool.call({ task_id: 'w11111111' }, ctx())
    expect(out).toBe('<status>completed</status>\n{"summary":"done"}')
  })

  it('终态任务读后置 notified=true（读过即静默）', async () => {
    const f = path.join(tmpDir, 'b5.log')
    fs.writeFileSync(f, 'done')
    registerTask(mkTask({ id: 'b5', status: 'completed', outputFile: f, notified: false }))
    await taskOutputTool.call({ task_id: 'b5' }, ctx())
    expect(getTask('b5')!.notified).toBe(true)
  })

  it('running 任务读后不置 notified', async () => {
    const f = path.join(tmpDir, 'b6.log')
    fs.writeFileSync(f, 'x')
    registerTask(mkTask({ id: 'b6', status: 'running', outputFile: f, notified: false }))
    await taskOutputTool.call({ task_id: 'b6' }, ctx())
    expect(getTask('b6')!.notified).toBe(false)
  })

  it('元数据：只读、无需权限', () => {
    expect(taskOutputTool.isReadOnly).toBe(true)
    expect(taskOutputTool.needsPermission({ task_id: 'x' })).toBe(false)
  })
})

describe('taskStopTool', () => {
  it('running bash → kill(SIGTERM) + 置 killed/notified', async () => {
    let killSig: string | undefined
    const child = { kill: (sig: string) => { killSig = sig; return true } }
    registerTask(mkTask({ id: 'b7', type: 'local_bash', status: 'running', child: child as any }))
    const out = await taskStopTool.call({ task_id: 'b7' }, ctx())
    expect(killSig).toBe('SIGTERM')
    expect(out).toBe('已停止任务 b7')
    const t = getTask('b7')!
    expect(t.status).toBe('killed')
    expect(t.notified).toBe(true)
    expect(t.endTime).toBeTypeOf('number')
  })

  it('running agent → abortController.abort() + 置 killed/notified', async () => {
    let aborted = false
    const ac = { abort: () => { aborted = true } }
    registerTask(mkTask({ id: 'a8', type: 'local_agent', status: 'running', abortController: ac as any }))
    const out = await taskStopTool.call({ task_id: 'a8' }, ctx())
    expect(aborted).toBe(true)
    expect(out).toBe('已停止任务 a8')
    expect(getTask('a8')!.status).toBe('killed')
    expect(getTask('a8')!.notified).toBe(true)
  })

  it('非 running 任务友好返回，不改状态', async () => {
    registerTask(mkTask({ id: 'b9', status: 'completed' }))
    const out = await taskStopTool.call({ task_id: 'b9' }, ctx())
    expect(out).toBe('任务 b9 非运行中（completed）')
    expect(getTask('b9')!.status).toBe('completed')
  })

  it('任务不存在友好返回', async () => {
    const out = await taskStopTool.call({ task_id: 'zzz' }, ctx())
    expect(out).toBe('任务 zzz 不存在')
  })

  it('元数据：非只读、无需权限', () => {
    expect(taskStopTool.isReadOnly).toBe(false)
    expect(taskStopTool.needsPermission({ task_id: 'x' })).toBe(false)
  })
})
