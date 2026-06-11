import fs from 'node:fs'

export function loadKey() {
  return fs.readFileSync(new URL('./secret.key', import.meta.url), 'utf8').trim()
}
