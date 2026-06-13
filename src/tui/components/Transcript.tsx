// src/tui/components/Transcript.tsx
// 转录展示：ink <Static> 承载已完成块（只渲染一次，流式 CLI 正确姿势，CC 同款），
// 动态区渲染进行中块（流式文本、思考块、运行中工具行）。
//
// Static 键选用项目在 items 数组中的全局索引，索引稳定。
// 不变式：transcriptReducer 保证 done 项只会追加到 doneItems 数组尾部——
// tool_start 触发时会先 seal 所有进行中的文本块，使完成顺序与数组顺序一致。
// ink Static 内部用自己的计数器去重——每次 rerender 只输出相对上次新增的尾部项，
// 从而保证 done 项迁入时不重复输出。
import React from 'react'
import { Box, Text, Static } from 'ink'
import { T } from '../theme.js'
import { renderMarkdown } from '../markdown.js'
import { ToolLine } from './ToolLine.js'
import type { TranscriptItem } from '../useChat.js'

/** 判断是否为"已完成"项（进入 Static 区）。*/
function isDone(item: TranscriptItem): boolean {
  if (item.kind === 'assistant' || item.kind === 'reasoning') return item.done
  if (item.kind === 'tool') return !item.running
  // user / usage / notice / bang 一旦出现即为完成态
  return true
}

/** CC 风格 ⏺ 项目符号 + 悬挂缩进：首行带 accent 圆点，续行缩进 2 空格。 */
function withBullet(content: string): React.ReactNode {
  const lines = content.split('\n')
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i}>
          {i === 0 ? <Text color={T.accent}>{'⏺ '}</Text> : '  '}
          {line}
        </Text>
      ))}
    </Box>
  )
}

function renderItem(item: TranscriptItem, index: number): React.ReactNode {
  switch (item.kind) {
    case 'user':
      return (
        <Box key={index}>
          <Text color={T.accent}>{'> '}</Text>
          <Text dimColor>{item.text}</Text>
        </Box>
      )

    case 'assistant':
      if (item.done) {
        // 完成：markdown 渲染（ANSI 着色串），⏺ 项目符号 + 悬挂缩进
        return <Box key={index}>{withBullet(renderMarkdown(item.text))}</Box>
      }
      // 进行中：原文（不跑 markdown，内容还不完整），同样带 ⏺ 项目符号
      return <Box key={index}>{withBullet(item.text)}</Box>

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
            ms={item.ms}
          />
        </Box>
      )

    case 'usage':
      // CC 式精简：轮末只用一行极简 dim 显示本轮输出 token + 累计花费（详细入/缓存/累计在底部 footer）
      return (
        <Box key={index}>
          <Text dimColor>{item.out} tokens · ${item.cost.toFixed(4)}</Text>
        </Box>
      )

    case 'notice': {
      const color = item.level === 'error' ? T.err : item.level === 'warn' ? T.warn : undefined
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

export function Transcript({ items }: { items: TranscriptItem[] }) {
  const doneItems = items.filter(isDone)
  const liveItems = items.filter(item => !isDone(item))

  return (
    <Box flexDirection="column">
      {/* Static 区：已完成项只渲染一次。传整个 doneItems 数组；ink 用内部索引去重，
          每次 rerender 只输出相对上次新增的尾部项，保证 done 项迁入时不重复。*/}
      <Static items={doneItems}>
        {(item, index) => (
          <Box key={index}>
            {renderItem(item, index)}
          </Box>
        )}
      </Static>

      {/* 动态区：进行中的项 */}
      <Box flexDirection="column">
        {liveItems.map((item, i) => renderItem(item, items.indexOf(item)))}
      </Box>
    </Box>
  )
}
