# M1 验收结果（2026-06-11）

环境：macOS / Node v22.22.1 / deepseek-v4-flash / 经 http://127.0.0.1:8118 代理访问 API。

## 验收清单（对照 spec §7 M1 标准）

| # | 项目 | 结果 |
|---|---|---|
| 1 | 真实仓库（123plane）代码探查问答 | **通过**。"versions 路由的权限是怎么校验的"→ 模型自主 Grep（并行 2 个）→ Read（并行 2 个）→ Read，回答引用真实路径与行号（`src/lib/auth/check-role.ts:16-42` 等），结论准确 |
| 2 | KV 缓存命中（第二轮起 > 0） | **通过**。会话内缓存命中逐调用递增：0 → 1024 → 1792 → 2816 → 3328 tokens；输出 token 仅占总用量 ~7% |
| 3 | Bash 权限弹窗 + 拒绝路径 | **通过**。允许（y）→ 执行并正确回答；拒绝（n）→ "用户拒绝了此操作"回灌，模型体面停止不硬来 |
| 4 | Esc 中断后上下文连贯 | **待手测**（需真 TTY，管道模式 keypress 不触发）。单测已覆盖中断后消息序列合法性（sealMessages） |

## 验收期间发现并已修复（共 3 个 commit）

1. **代理适配**：Node fetch 不读 `https_proxy` 环境变量，本机直连 DeepSeek 超时。修复：`createClient` 检测代理环境变量，经 undici `ProxyAgent` + 同包 `fetch` 接入（两者必须同源，混用 Node 内置 fetch 会 `InvalidArgumentError`）。
2. **v4-flash 默认开 thinking**：不显式传 `thinking:{type:"disabled"}` 时每个请求都带隐藏思考链——实测同一问题 39 token vs 1 token（39 倍输出成本）。修复：默认显式 disabled。**这是本次验收最有价值的发现。**
3. **reasoning 流不可见**：`/think` 开启时 `reasoning_content` 增量原先被静默丢弃。修复：流式显示（仅显示，不入 messages 上下文）。

## 待调 prompt 清单（M2 开工输入）

- 暂未观察到工具调用行为问题：并行调用守则生效（两轮各并行 2 个调用）、引用行号格式正确、拒绝后不重试硬闯。样本量小（2 个会话），M2 期间持续记录。
- `/think` 模式 reasoning 流与正文无视觉区分（建议 M2 在 REPL 给 reasoning 加暗色样式）。
- REPL 排版：usage 行与下一提示符之间双空行（cosmetic，M2 顺手修）。

## 已知接受的权衡（带入 M2）

- Bash `always` 规则取首行前两词（`rm -rf:*` 面宽）→ M2 考虑高危模式警告
- `/model` `/think` 中途切换会重置 KV 缓存（无提示）
- openai SDK 自带重试（默认 2 次）与 withRetry 叠加 → M2 顺手 `maxRetries: 0`

## 结论

M1「能对话」验收**通过**（4 项中 3 项自动化验证通过，Esc 项留待日常使用确认）。代码 21 commits、47 单测全绿、最终整体审查 READY。打 tag `v0.1.0-m1`。
