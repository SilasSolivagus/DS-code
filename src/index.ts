// src/index.ts
import { createClient } from './api.js'
import { startRepl } from './repl.js'

const yolo = process.argv.includes('--yolo')
try {
  const client = createClient()
  await startRepl({ client, yolo })
  process.exit(0)
} catch (e: any) {
  console.error(e?.message ?? e)
  process.exit(1)
}
