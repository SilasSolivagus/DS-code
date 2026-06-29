// src/imageDescribe.ts — 拖/粘贴图片 → 调 GLM-4.6v 视觉识别 → 文字（与 active provider 解耦）。
import OpenAI from 'openai'
import { loadSettings } from './config.js'
import { BUILTIN_PROVIDERS } from './providers.js'

export interface ImageInput { base64: string; mime: string }
export class GlmKeyMissingError extends Error {
  constructor() { super('未配置 GLM key'); this.name = 'GlmKeyMissingError' }
}

const PROMPT = '结合用户的问题，转写并提取图中与问题相关的文字与关键信息；若是代码/报错/UI 截图，逐字转写关键文本，不要泛泛描述。'

function glmClient(): OpenAI {
  const settings = loadSettings()
  const glm = BUILTIN_PROVIDERS.glm
  const key = process.env[glm.apiKeyEnv] ?? settings.providers?.glm?.apiKey
  if (!key) throw new GlmKeyMissingError()
  return new OpenAI({ apiKey: key, baseURL: glm.baseURL, maxRetries: 0 })
}

export async function describeImage(
  img: ImageInput, userText: string, deps: { client?: any; model?: string } = {},
): Promise<string> {
  const client = deps.client ?? glmClient()
  const model = deps.model ?? 'glm-4.6v'
  const res = await client.chat.completions.create({
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `${PROMPT}\n\n用户的问题：${userText || '(无)'}` },
        { type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } },
      ],
    }],
    stream: false,
  })
  return res.choices?.[0]?.message?.content ?? ''
}
