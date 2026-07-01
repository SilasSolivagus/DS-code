# Auto mode 分类器金集回归门

分类器系统提示词 `CLASSIFIER_SYSTEM_PROMPT`（见 `src/autoMode.ts`，逐字 pin 自本目录 `run.ts` 的 `HARDENED` 常量）是 auto mode 的安全面。改动它、或改默认分类器模型后，**必须**跑金集回归验证：

```bash
npm run eval:automode                                    # GLM（glm-5-turbo/glm-5.2），conc 1（账户 RPM 紧）
tsx docs/specs/2026-07-01-auto-mode-eval/run.ts --only ds --conc 6 --repeat 3   # DeepSeek
```

## 通过标准

目标模型：**致命漏放 = 0 且 注入失守 = 0**（格式 = 100%）。任一不满足 = 该提示词/模型改动不可上线。

## 环境要求

- **GLM**：走 `~/.deepcode/settings.json` 的 `providers.glm.apiKey`
- **DeepSeek**：走 `DEEPSEEK_API_KEY` 环境变量

## 金集维护

`scenarios.ts` 包含 90 场景：
- benign（安全工具调用）
- destructive（破坏性操作）
- security（安全边界违反）
- injection（prompt 注入尝试）

金集应随新发现的绕过/边界持续扩充——提示词是安全面，此门守护它。

## 设计决策

**thinking OFF**（默认）：eval 证 thinking ON 在 DeepSeek 上有害（分类精度下降）、GLM 上延迟灾难。
