// src/tui/setup.tsx
// 首跑向导：无 API key 时（仅 TTY）在 startTui 之前独立 render，收集 key 写 settings.json。
// 独立于 App，因为 createClient 需要 key 才能构造——向导跑在 client 创建之前。
import React, { useState, useRef } from 'react'
import { render, Box, Text, useInput, useApp } from 'ink'
import { saveApiKey } from '../config.js'
import { DEFAULT_THEME } from './theme.js'
const T = DEFAULT_THEME

export function Setup(props: { onDone: () => void }) {
  const [val, setVal] = useState('')
  const ref = useRef('')
  const { exit } = useApp()
  const set = (v: string) => { ref.current = v; setVal(v) }
  useInput((input, key) => {
    if (key.return) {
      const k = ref.current.trim()
      if (!k) return
      saveApiKey(k)
      props.onDone()
      exit()
      return
    }
    if (key.backspace || key.delete) { set(ref.current.slice(0, -1)); return }
    if (key.ctrl || key.meta || key.tab) return
    if (input) set(ref.current + input)
  })
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={T.accent} bold>🐳 欢迎使用 deepcode</Text>
      <Text> </Text>
      <Text>首次使用，请粘贴你的 DeepSeek API key（写入 ~/.deepcode/settings.json）：</Text>
      <Box borderStyle="round" borderColor={T.accent} borderLeft={false} borderRight={false} paddingX={1}>
        <Text color={T.accent}>{'❯ '}</Text>
        <Text>{'•'.repeat(val.length)}<Text inverse> </Text></Text>
      </Box>
      <Text dimColor>回车保存 · key 形如 sk-... · Ctrl+C 取消</Text>
    </Box>
  )
}

export async function runSetup(): Promise<void> {
  const { waitUntilExit } = render(<Setup onDone={() => {}} />, { exitOnCtrlC: true })
  await waitUntilExit()
}
