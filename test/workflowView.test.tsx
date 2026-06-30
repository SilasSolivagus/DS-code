// test/workflowView.test.tsx
import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { WorkflowView, formatWorkflowProgress } from '../src/tui/WorkflowView.js'

describe('formatWorkflowProgress', () => {
  it('汇总 phase/agent 计数与完成态', () => {
    const recs = [
      { type: 'workflow_phase', index: 0, title: 'Scan', phaseIndex: 0 },
      { type: 'workflow_agent', index: 1, agentId: 'a', model: 'm', status: 'ok', prompt: 'p', optsKey: '{}', result: 1 },
      { type: 'workflow_complete', runId: 'wf_abc', agents: 1, ms: 1234 },
    ] as any
    const s = formatWorkflowProgress(recs, { id: 'w1', status: 'completed' } as any)
    expect(s.agents).toBe(1)
    expect(s.phases[0].title).toBe('Scan')
    expect(s.done).toBe(true)
    expect(s.ms).toBe(1234)
  })

  it('进行中的 run（无 workflow_complete）用 task.id 作 runId', () => {
    const recs = [
      { type: 'workflow_phase', index: 0, title: 'Scan', phaseIndex: 0 },
      { type: 'workflow_agent', index: 1, agentId: 'a', model: 'm', status: 'ok', prompt: 'p', optsKey: '{}', result: 1 },
    ] as any
    const s = formatWorkflowProgress(recs, { id: 'w1', status: 'running' } as any)
    expect(s.runId).toBe('w1')
    expect(s.done).toBe(false)
  })

  it('Gap 3: workflow_start 记录中的 name 正确出现在 summary.name', () => {
    const recs = [
      { type: 'workflow_start', runId: 'wf_abc', name: 'My Workflow' },
      { type: 'workflow_phase', index: 0, title: 'Phase 1', phaseIndex: 0 },
      { type: 'workflow_complete', runId: 'wf_abc', agents: 2, ms: 500 },
    ] as any
    const s = formatWorkflowProgress(recs, { id: 'task1', status: 'completed' } as any)
    expect(s.name).toBe('My Workflow')
  })
})

describe('WorkflowView 渲染', () => {
  it('显示 phase 标题与 Completed 行', () => {
    const runs = [{ runId: 'wf_abc', name: 't', done: true, agents: 1, ms: 1234, phases: [{ title: 'Scan', agents: 1 }] }]
    const { lastFrame } = render(<WorkflowView runs={runs as any} />)
    expect(lastFrame()).toContain('Scan')
    expect(lastFrame()).toMatch(/Completed in/)
  })
})
