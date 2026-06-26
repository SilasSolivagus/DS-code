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
import { Box, Static } from 'ink'
import { useTheme, BLOCK_GAP } from '../theme.js'
import type { TranscriptItem } from '../useChat.js'
import { renderItem, isDone } from '../renderItem.js'

type StaticEntry = TranscriptItem | { __banner: true }

export function Transcript({ items, banner }: { items: TranscriptItem[]; banner?: React.ReactNode }) {
  const theme = useTheme()
  const doneItems = items.filter(isDone)
  const liveItems = items.filter(item => !isDone(item))
  // 欢迎框作为 Static 第一项：开机渲染一次、随对话滚入历史（仿 CC）——既不在说话后消失，
  // 也不在实时区反复重画。ink Static 只对新增尾部项输出，首项 banner 恒定不重渲。
  const staticItems: StaticEntry[] = banner ? [{ __banner: true }, ...doneItems] : doneItems

  return (
    <Box flexDirection="column">
      {/* Static 区：banner + 已完成项只渲染一次。ink 用内部索引去重，每次 rerender 只输出相对上次新增的尾部项。*/}
      <Static items={staticItems}>
        {(item, index) => (
          <Box key={index} marginTop={index === 0 ? 0 : BLOCK_GAP}>
            {'__banner' in item ? banner : renderItem(item, index, theme)}
          </Box>
        )}
      </Static>

      {/* 动态区：进行中的项 */}
      <Box flexDirection="column">
        {liveItems.map((item, i) => (
          <Box key={i} marginTop={BLOCK_GAP}>{renderItem(item, items.indexOf(item), theme)}</Box>
        ))}
      </Box>
    </Box>
  )
}
