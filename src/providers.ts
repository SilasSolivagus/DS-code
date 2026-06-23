// src/providers.ts —— 多 provider 单一事实源（内置 deepseek/glm + custom）。
import { loadSettings, type Settings } from './config.js'

export type Dialect = 'deepseek' | 'glm' | 'openai'

/** 每模型元数据。hit/miss/out = CNY/1M（镜像 pricing.ts PRICES）。 */
export interface ModelMeta {
  hit: number
  miss: number
  out: number
  contextWindow: number
  supportsThinking: boolean
}

/** custom provider（用户在 settings.providers.custom 自填的 OpenAI 兼容后端）。 */
export interface CustomProvider {
  baseURL: string
  apiKeyEnv?: string
  apiKey?: string
  dialect?: Dialect
  models: { fast: string; smart: string }
  meta?: Record<string, ModelMeta>
  defaultMeta?: ModelMeta
}

export interface ProviderPreset {
  id: string
  baseURL: string
  apiKeyEnv: string
  dialect: Dialect
  /** 归属判定前缀（deepseek→'deepseek'、glm→'glm'）；custom 无前缀走 meta∪models 成员判定。 */
  modelPrefix?: string
  models: { fast: string; smart: string }
  meta: Record<string, ModelMeta>
  /** 未知档（未来 deepseek-v4.1/glm-5.3…）兜底，避免回落全局 200k/0。 */
  defaultMeta: ModelMeta
}

// 价格单位 CNY/1M（待核实 bigmodel.cn/pricing 的为 GLM 估值；deepseek 取自 pricing.ts 现值）。
const GLM_DEFAULT: ModelMeta = { hit: 0.6, miss: 3, out: 14, contextWindow: 200_000, supportsThinking: true } // 待核实

export const BUILTIN_PROVIDERS: Record<string, ProviderPreset> = {
  deepseek: {
    id: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    dialect: 'deepseek',
    modelPrefix: 'deepseek',
    models: { fast: 'deepseek-v4-flash', smart: 'deepseek-v4-pro' },
    meta: {
      'deepseek-v4-flash': { hit: 0.02, miss: 1, out: 2, contextWindow: 1_000_000, supportsThinking: true },
      'deepseek-v4-pro': { hit: 0.025, miss: 3, out: 6, contextWindow: 1_000_000, supportsThinking: true },
    },
    defaultMeta: { hit: 0.025, miss: 3, out: 6, contextWindow: 1_000_000, supportsThinking: true }, // = pro 保守兜底
  },
  glm: {
    id: 'glm',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnv: 'ZHIPUAI_API_KEY',
    dialect: 'glm',
    modelPrefix: 'glm',
    models: { fast: 'glm-5-turbo', smart: 'glm-5.2' },
    meta: { // hit/miss/out = CNY/1M，待核实 bigmodel.cn/pricing
      'glm-5.2': { hit: 1.85, miss: 10, out: 31, contextWindow: 1_000_000, supportsThinking: true },
      'glm-5.1': { hit: 1, miss: 5, out: 16, contextWindow: 200_000, supportsThinking: true },
      'glm-5': { hit: 1, miss: 5, out: 16, contextWindow: 200_000, supportsThinking: true },
      'glm-5-turbo': { hit: 0.2, miss: 1, out: 3, contextWindow: 200_000, supportsThinking: true },
      'glm-4.7': { hit: 0.6, miss: 3, out: 14, contextWindow: 200_000, supportsThinking: true },
      'glm-4.6': { hit: 0.6, miss: 3, out: 14, contextWindow: 200_000, supportsThinking: true },
      'glm-4.5': { hit: 0.6, miss: 3, out: 14, contextWindow: 128_000, supportsThinking: true },
      'glm-4.5-air': { hit: 0.2, miss: 1, out: 6, contextWindow: 128_000, supportsThinking: true },
    },
    defaultMeta: GLM_DEFAULT,
  },
}

export function resolveActiveProvider(settings: Settings): ProviderPreset {
  const id = settings.provider ?? 'deepseek'
  if (id === 'custom') {
    const c = settings.providers?.custom
    if (!c || !c.baseURL || !c.models) return BUILTIN_PROVIDERS.deepseek
    return {
      id: 'custom',
      baseURL: c.baseURL,
      apiKeyEnv: c.apiKeyEnv ?? 'DEEPCODE_API_KEY',
      dialect: c.dialect ?? 'openai',
      modelPrefix: undefined,
      models: c.models,
      meta: c.meta ?? {},
      defaultMeta: c.defaultMeta ?? { hit: 0, miss: 0, out: 0, contextWindow: 200_000, supportsThinking: false },
    }
  }
  return BUILTIN_PROVIDERS[id] ?? BUILTIN_PROVIDERS.deepseek
}

export function modelMeta(preset: ProviderPreset, modelId: string): ModelMeta {
  return preset.meta[modelId] ?? preset.defaultMeta
}

export function belongsToProvider(preset: ProviderPreset, modelId: string): boolean {
  if (preset.modelPrefix) return modelId.startsWith(preset.modelPrefix)
  return modelId in preset.meta || modelId === preset.models.fast || modelId === preset.models.smart
}

/** 便利封装：读 settings 解析 active preset。 */
export function activeProvider(): ProviderPreset {
  return resolveActiveProvider(loadSettings())
}
export function activeModelMeta(modelId: string): ModelMeta {
  return modelMeta(activeProvider(), modelId)
}
export function activeFastModel(): string {
  return activeProvider().models.fast
}
export function activeSmartModel(): string {
  return activeProvider().models.smart
}

/** 子调用 model 档解析（运行时第二段）：inherit/undefined→父；flash/fast→active fast；smart→active smart；具体 id→透传。 */
export function resolveSubModel(alias: string | undefined, parent: string): string {
  if (!alias || alias === 'inherit') return parent
  if (alias === 'flash' || alias === 'fast') return activeFastModel()
  if (alias === 'smart') return activeSmartModel()
  return alias
}

export type { Settings }
