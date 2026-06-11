// scripts/smoke-api.ts —— 用法: DEEPSEEK_API_KEY=sk-... npx tsx scripts/smoke-api.ts "你好"
import { createClient, chatStream } from '../src/api.js'

const client = createClient()
const gen = chatStream(client, {
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: process.argv[2] ?? '用一句话自我介绍' }],
  tools: [],
  thinking: false,
  signal: new AbortController().signal,
})
let step
while (!(step = await gen.next()).done) process.stdout.write(step.value.delta)
console.log('\n--- usage:', JSON.stringify(step.value.usage), 'finish:', step.value.finishReason)
