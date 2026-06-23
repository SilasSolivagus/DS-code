// src/tui/resumeModel.ts —— resume 时模型归属校验，防跨 provider 端点漂移。
import { belongsToProvider, type ProviderPreset } from '../providers.js'

/** session 记录的 model 若不归属 active provider，回落 active fast；否则保留（含同 provider 未来新档）。 */
export function resolveResumeModel(sessionModel: string, preset: ProviderPreset): string {
  return belongsToProvider(preset, sessionModel) ? sessionModel : preset.models.fast
}

/** /model 无参轮换：当前是 smart → fast，否则（fast 或自定义档）→ smart 的对立面；非 fast/smart → 落 fast。 */
export function rotateModel(current: string, preset: ProviderPreset): string {
  if (current === preset.models.smart) return preset.models.fast
  if (current === preset.models.fast) return preset.models.smart
  return preset.models.fast
}
