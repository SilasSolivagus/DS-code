# M2 验收结果（2026-06-11）

环境：同 M1（macOS / Node v22.22.1 / deepseek-v4-flash / 本地代理）。

## 验收清单（对照 spec §7 M2 标准）

| # | 项目 | 结果 |
|---|---|---|
| 1 | 独立完成"修一个真 bug"全流程（非 yolo） | **通过**。`/accept` 后：跑 npm test（Bash 确认）→ 并行 Read+Glob 探查 → 定位 `calc.mjs:4` 并解释 off-by-one → Edit 免确认修复 → 复测通过。全程仅 2 次 Bash 确认，Edit 零摩擦 |
| 2 | read-before-edit 闸门 | **通过**（10 个单测：未读拒绝/外部修改拦截/连续编辑/唯一性/replace_all/$& 防御/空串拒绝/多行替换） |
| 3 | acceptEdits 模式语义 | **通过**：Edit/Write 免确认、Bash 仍确认；yolo 下 /accept 提示不切换 |
| 4 | 第二轮 bench（6 场景 × 双轨 × 2） | **双轨 12/12**。s6 修 bug：deepcode 11.9k 入 token/13.3s vs CC 227k/137.4s（19 倍 token、10 倍耗时，结果相同）。详见 bench/results/2026-06-11-m2-round2.md |

## 实现期间审查抓出并修复的问题

1. **Critical（Edit）**：空 `old_string` + `replace_all` 会经 `split('').join()` 把新串插进每个字符之间，静默腐化文件 → zod `.min(1)` 拒绝
2. **Important（权限）**：`--force-with-lease`（安全做法）被 `--force\b` 误报 → 改 `--force(?!-)`
3. **Important（权限）**：多行高危命令 always 后规则永不匹配（存储侧归一化而匹配侧没有）→ matchRule 与存储两侧统一 `\n→空格` 归一化

## 待调 prompt 清单（M3 开工输入）

- 本轮未观察到新的模型行为问题；M1 记录的"引用纪律"问题在系统提示词强化后，bench s1 已不再丢分
- thinking 模式的 reasoning 流已有暗色+分隔渲染，真实使用中观感待积累反馈

## 带入 M3 的权衡

- Write 的 `existsSync→write` TOCTOU 窗口（单用户 CLI 可接受，已记录）
- `permMode` 无持久状态指示（acceptEdits 开着容易忘）→ M3 做状态行时一并解决
- bench CC 轨耗时含本机异常 CLI 启动开销（解读时已注记）

## 结论

M2「能干活」验收**通过**。21+10 commits、66 单测全绿。打 tag `v0.2.0-m2`。
