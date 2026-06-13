// src/version.ts
// 运行时读 package.json 的 version。dev(src/version.ts) 与 dist(dist/version.js) 下
// '../package.json' 都指向包根 package.json，无需 import assertion。
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
export const VERSION: string = pkg.version
