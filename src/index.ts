// src/index.ts
import { createClient } from './api.js'
import { startRepl } from './repl.js'

const yolo = process.argv.includes('--yolo')
const continueSession = process.argv.includes('--continue') || process.argv.includes('-c')
try {
  const client = createClient()
  await startRepl({ client, yolo, continueSession })
  process.exit(0)
} catch (e: any) {
  console.error(e?.message ?? e)
  process.exit(1)
}
