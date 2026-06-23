// src/tui/renderItem.tsx
// 单条转录项渲染（从 Transcript 抽出，供内联 Transcript 与全屏 ScrollView 共用）。
// 行为与抽出前完全一致——任何改动都会破坏现有 transcript 回归测试。
import React from 'react'
import { Box, Text } from 'ink'
import type { Theme } from './theme.js'
import { renderMarkdown } from './markdown.js'
import { ToolLine } from './components/ToolLine.js'
import { withBullet } from './withBullet.js'
import { StreamingMarkdown } from './streamingMarkdown.js'
import type { TranscriptItem } from './useChat.js'

/** 判断是否为"已完成"项（进入 Static 区）。*/
export function isDone(item: TranscriptItem): boolean {
  if (item.kind === 'assistant' || item.kind === 'reasoning') return item.done
  if (item.kind === 'tool') return !item.running
  // user / usage / notice / bang 一旦出现即为完成态
  return true
}

export function renderItem(item: TranscriptItem, index: number, theme: Theme): React.ReactNode {
  switch (item.kind) {
    case 'user':
      return (
        <Box key={index}>
          <Text color={theme.accent}>{'> '}</Text>
          <Text dimColor>{item.text}</Text>
        </Box>
      )

    case 'assistant':
      if (item.done) {
        // 完成：markdown 渲染（ANSI 着色串），⏺ 项目符号 + 悬挂缩进
        return <Box key={index}>{withBullet(renderMarkdown(item.text), theme)}</Box>
      }
      // 进行中：流式增量 markdown 渲染（稳定前缀缓存 + 末尾重算）
      return <Box key={index}><StreamingMarkdown text={item.text} /></Box>

    case 'reasoning':
      if (item.done) {
        const lineCount = item.text.split('\n').length
        return (
          <Box key={index}>
            <Text dimColor>✻ 已思考（{lineCount} 行）</Text>
          </Box>
        )
      }
      // 进行中：显示 "✻ 思考中…" + 最近 3 行（CC 同款 dim 灰斜体，非紫色）
      {
        const lines = item.text.split('\n')
        const tail = lines.slice(-3)
        return (
          <Box key={index} flexDirection="column">
            <Text dimColor italic>✻ 思考中…</Text>
            {tail.map((l, i) => (
              <Text key={i} dimColor italic>{l}</Text>
            ))}
          </Box>
        )
      }

    case 'tool':
      return (
        <Box key={index}>
          <ToolLine
            name={item.name}
            desc={item.desc}
            running={item.running}
            ok={item.ok}
            preview={item.preview}
            previewExtra={item.previewExtra}
            ms={item.ms}
          />
        </Box>
      )

    case 'usage':
      // CC 式精简：轮末只用一行极简 dim 显示本轮输出 token + 累计花费（详细入/缓存/累计在底部 footer）
      return (
        <Box key={index}>
          <Text dimColor>{item.out} tokens · ¥{item.cost.toFixed(4)}</Text>
        </Box>
      )

    case 'notice': {
      const color = item.level === 'error' ? theme.err : item.level === 'warn' ? theme.warn : undefined
      return (
        <Box key={index}>
          <Text dimColor={!color} color={color}>{item.text}</Text>
        </Box>
      )
    }

    case 'bang':
      return (
        <Box key={index} flexDirection="column">
          <Text dimColor>$ {item.cmd}</Text>
          {item.output.split('\n').map((l, i) => (
            <Text key={i} dimColor>{l}</Text>
          ))}
        </Box>
      )
  }
}
