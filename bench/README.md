# bench —— deepcode vs CC+DeepSeek 对照实验

两边引擎完全相同（deepseek-v4-flash），唯一变量是 harness：

- **实验组**：deepcode（管道输入 + `--yolo`）
- **对照组**：Claude Code + DeepSeek Anthropic 兼容端点（`claude -p` + `--dangerously-skip-permissions`，sonnet 映射到 v4-flash）

测的是"CC 的魔法有多少在 harness、多少在模型"，同时给 deepcode 每个里程碑一个客观标尺。

## 运行

```bash
DEEPSEEK_API_KEY=sk-... npx tsx bench/run.ts            # 全场景 ×2 次
npx tsx bench/run.ts --runs 3                            # 每场景 3 次
npx tsx bench/run.ts --scenario s1-assembler --track cc  # 单场景单轨调试
```

结果写入 `bench/results/<日期>-m1.{json,md}`。

## 指标与口径

- **成功**：回答命中场景定义的全部关键词正则（`scenarios.json` 的 `expected`）
- **token**：两轨都取 API 返回的 usage；cc 轨 `input_tokens + cache_read + cache_creation` 为总输入
- **缓存命中**：deepcode 取 DeepSeek 的 `prompt_cache_hit_tokens` 累计；cc 轨取 `cache_read_input_tokens`（单轮请求实测为 0，多轮会话内兼容层会把 DeepSeek 前缀缓存命中映射回来）
- **耗时**：外部墙钟（含 CLI 启动）

## 已知不公平点（解读结果前必读）

1. CC 的系统提示词 + 工具定义固定开销 ~37k token/请求（实测 "1+1" 输入 36,805），deepcode <1.5k——这不是测量误差，是两种设计的真实成本差
2. CC 轨 `total_cost_usd` 按 Anthropic 牌价算，对 DeepSeek 无意义，已弃用
3. CC 版本随升级漂移，结果文件记录 `claude --version`
4. 兼容层不支持图像内容；场景集只含纯文本任务（DeepSeek API 本身也不收图）
5. 模型有随机性，单次结果无意义，看中位数；N≥3 才值得引用

## 场景类型与区分度设计

- **qa**（s1-s5）：只读问答，关键词正则评分
- **fix**（s6-s8）：复制 fixture 到临时目录，跑完用 verifyCmd（测试命令）判分。s6 单文件热身；s7 多文件协同修改；s8 误导性报错（失败信息像舍入问题，真因是组合顺序）
- **negative**（s9）：不可完成的任务，测诚实性——约束守住（不伪造文件/不改测试）且明确承认做不到才算过。作弊修复会被 verifyCmd 判负

第二轮 12/12 全绿暴露了天花板效应，s7-s9 即为此而加；N 默认升至 3。
