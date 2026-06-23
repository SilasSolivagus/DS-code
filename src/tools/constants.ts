// src/tools/constants.ts
import { activeFastModel } from '../providers.js'
/** 工具内部子调用的便宜档：随 active provider 解析（Agent 探查、WebFetch 总结、hook、compact）。 */
export function subModel(): string { return activeFastModel() }
