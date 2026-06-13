// src/tui/components/Banner.tsx
// 启动欢迎框（对照 CC 双列欢迎页）：圆角 accent 框，三列布局——左列（标题/欢迎/鲸鱼/账号/目录）、
// 中间 │ 分隔列、右列（上手提示/小贴士）。全用 <Text> 行 + marginLeft 控间距，不用 paddingY/嵌套边框/
// 空 Box——那些在 row flex 下会让 ink(yoga) 布局阶梯错乱。cwd/model 由 App 传入，用户名从 os 读。
import React from 'react'
import os from 'node:os'
import { Box, Text } from 'ink'
import { T } from '../theme.js'

const WHALE = ['  .-"""-.', ' ( o   o )  ~', '  \\  ^  /', "   '---'"]

export function Banner(p: { cwd: string; model: string }) {
  let user = ''
  try { user = os.userInfo().username } catch { /* 兜底空 */ }

  // 左列各行（含空行用 ' '）；分隔列高度取左列行数
  const left = [
    <Text key="t" color={T.accent} bold>🐳 deepcode</Text>,
    <Text key="w" bold>{user ? `欢迎回来，${user}！` : '欢迎使用 deepcode！'}</Text>,
    <Text key="b1"> </Text>,
    ...WHALE.map((l, i) => <Text key={`wh${i}`} color={T.accent}>{l}</Text>),
    <Text key="b2"> </Text>,
    <Text key="m" dimColor>{p.model} · DeepSeek</Text>,
    <Text key="c" dimColor>{p.cwd}</Text>,
  ]
  const right = [
    <Text key="h1" color={T.accent} bold>上手</Text>,
    <Text key="r1">输入 /help 看全部命令</Text>,
    <Text key="r2">/init 生成 CLAUDE.md</Text>,
    <Text key="b"> </Text>,
    <Text key="h2" color={T.accent} bold>小贴士</Text>,
    <Text key="r3" dimColor>@ 引用文件 · ! 直跑 shell</Text>,
    <Text key="r4" dimColor>/model 切模型 · /think 开思考</Text>,
  ]

  return (
    <Box borderStyle="round" borderColor={T.accent} paddingX={2}>
      <Box flexDirection="column">{left}</Box>
      <Box flexDirection="column" marginLeft={3} marginRight={3}>
        {left.map((_, i) => <Text key={i} dimColor>│</Text>)}
      </Box>
      <Box flexDirection="column">{right}</Box>
    </Box>
  )
}
