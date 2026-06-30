// src/tui/WorkflowView.tsx
import React from 'react'
import { Box, Text } from 'ink'
import type { JournalRecord } from '../workflow/types.js'

export interface WorkflowRunSummary {
  runId: string
  name: string
  done: boolean
  agents: number
  ms: number
  phases: { title: string; agents: number }[]
}

export function formatWorkflowProgress(records: JournalRecord[], task: { id: string; status: string }): WorkflowRunSummary {
  const phases: { title: string; agents: number }[] = []
  let agents = 0, ms = 0, done = false, runId = task.id, name = ''
  for (const r of records) {
    if (r.type === 'workflow_phase') phases.push({ title: r.title, agents: 0 })
    else if (r.type === 'workflow_agent') { agents++; if (phases.length) phases[phases.length - 1].agents++ }
    else if (r.type === 'workflow_complete') { done = true; ms = r.ms; runId = r.runId; agents = r.agents }
  }
  return { runId, name, done: done || task.status === 'completed', agents, ms, phases }
}

export function WorkflowView({ runs }: { runs: WorkflowRunSummary[] }) {
  return (
    <Box flexDirection="column">
      {runs.map(run => (
        <Box key={run.runId} flexDirection="column" marginBottom={1}>
          <Text bold>{run.name || run.runId}</Text>
          {run.phases.map((p, i) => (
            <Text key={i}>  {run.done ? '✓' : '⟳'} {p.title} · {p.agents} agents</Text>
          ))}
          {run.done && <Text dimColor>Completed in {(run.ms / 1000).toFixed(1)}s · {run.agents} agents</Text>}
        </Box>
      ))}
    </Box>
  )
}
