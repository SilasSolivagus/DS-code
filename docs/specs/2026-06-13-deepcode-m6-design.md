# deepcode M6 设计：可发布 v0.6 + WebFetch

2026-06-13。M5（v0.5.0-m5，CC UI 1:1 复刻）已封板。M6 目标：把 deepcode 从「自用脚本」变成「能 `npm i -g` 装来用的工具」，外加一个便宜的能力甜头 WebFetch。

## 范围与决策

用户经头脑风暴拍板（AskUserQuestion 逐项）：

| 维度 | 决策 |
|---|---|
| M6 北极星 | **可发布**（分发是闸门，能力再强装不上也没用） |
| 分发方式 | **真正 npm publish**（`npm i -g <包>`） |
| 包名 | **`ds-code`**（与 GitHub 仓 DS-code 一致；命令名仍 `deepcode`，bin 字段解耦包名与命令名） |
| 构建 | **tsc → dist/**（复用现成 tsc，代码已 `.js` 扩展名导入 ESM-ready，零额外工具） |
| 首跑无 key | **TUI 向导输入 → 写 `~/.deepcode/config.json`(600)**；读取顺序 env 优先 → 配置文件 |
| `--plain`/repl.ts | **删除**（TUI 已成熟，砍双状态机；非 TTY 仍走 headless 不受影响） |
| WebFetch | **收入 M6**（低-中工作量、独立、立即有用） |

**非目标（→ M7）**：`/rewind` 与可写 subagent+worktree。原因：查实现发现现有「每轮 fs 快照」是 `path→mtime` 清单（read-before-edit 闸门用），**非内容快照**；忠实回退需从零建内容快照、且 Bash 任意改文件难拦（需影子 git 整树快照）——这套基建与 M7 #6 worktree 同源，合并到 M7 设计。

**不碰**：核心 loop/api/tools/session 逻辑零改动（除新增 WebFetch 工具 + 删 repl + api.ts 改为经 config.ts 读 key）。headless 路径逻辑不变。

## 模块设计

### 1. 构建管线（tsc → dist）

- 新 `tsconfig.build.json`：继承主 `tsconfig.json`，覆盖 `noEmit:false`、`outDir:"dist"`、`rootDir:"src"`、`include:["src"]`、`exclude:["test","scripts"]`。
- `src/index.ts` 首行加 shebang `#!/usr/bin/env node`（tsc 保留首行 shebang）。
- `package.json` 改动：
  - `name:"deepcode"` → `"ds-code"`
  - 删 `"private":true`
  - 加 `"bin":{"deepcode":"dist/index.js"}`
  - 加 `"files":["dist","README.md"]`
  - 加 `"engines":{"node":">=18"}`
  - scripts 加 `"build":"tsc -p tsconfig.build.json"`、`"prepublishOnly":"npm run build"`
- 产物：ESM JS（`.js` 导入已就位直接解析）；ink/react 是运行时 dependencies；tsx 留 devDependencies 不随包发布。

### 2. 配置 + key 解析（扩展现有 src/config.ts）

> 实现期发现：`src/config.ts` 已存在（管理 `~/.deepcode/settings.json` 的 `Settings`，已含 model/baseURL）。apiKey 并入**现有 settings.json**，不新建 config.json——避免两个配置文件。

- `Settings` 接口加 `apiKey?: string`；`loadSettings` 读出它。
- 新 `hasApiKey()`：`!!(process.env.DEEPSEEK_API_KEY ?? loadSettings().apiKey)`。
- 新 `saveApiKey(key)`：`loadSettings()` 合并 apiKey → `saveSettings()` → `chmod 600` 整个 settings.json。
- `api.ts` 的 `createClient`（约 89 行）：`apiKey = process.env.DEEPSEEK_API_KEY ?? loadSettings().apiKey`，两处都无才抛错（env 优先语义不变，新增 settings 兜底）。baseURL 已从 loadSettings 取，不动。

### 3. 首跑向导（src/tui/setup.tsx 新建，startTui 前的独立 render）

> 实现期发现：`index.ts` 顶部就 `createClient()`（无 key 直接抛），向导没机会跑。故向导是 `startTui` **之前**的一次独立 ink render，不是 App 内 gating；client 创建延后到向导之后。

- `index.ts` TTY 分支：`if (!hasApiKey()) await runSetup()` → 再 `createClient()` → `startTui`。删顶部公共 `createClient()`，各分支自建（headless/管道分支无 key 仍直接抛，非交互无向导）。
- `Setup` 组件：鲸鱼欢迎 + 单行输入 `贴入你的 DeepSeek API key:`（密文以 `•` 遮显，回车即存）→ `saveApiKey` → `useApp().exit()`。
- `runSetup()`：`render(<Setup/>)` + `waitUntilExit()`。
- 非 TTY/headless 无 key：维持现状（`createClient` 抛错提示），向导不介入。

### 4. 入口简化（删 --plain / repl.ts）

- 删 `src/repl.ts`、`index.ts` 的 `--plain` 分支、`test/` 中 repl 专属用例。
- 入口收敛：`-p <prompt>` → headless；非 TTY stdin → headless；TTY → TUI（无 key 先 Setup）。
- `useChat.ts` 成为唯一交互状态机（repl 原是其旧双份，删除消除漂移风险）。连带清理仅 repl 引用的死代码。

### 5. 版本号源头（src/version.ts 新建）

- 运行时读 `package.json` 的 `version` 字段导出 `VERSION`（避免 import json 的 assert 兼容问题，用 `readFileSync` + 相对 dist 的路径解析，或 `createRequire`）。
- Banner 标题 `🐳 deepcode` → `🐳 deepcode v{VERSION}`。
- 发布时 bump `package.json` `0.1.0 → 0.6.0`（与 tag 序列对齐，发布动作里做，非本设计预先改）。

### 6. WebFetch 工具（CC 式，src/tools/webfetch.ts 新建）

CC 式 = 抓取网页 + 用用户问题让子模型从内容中作答（不是返回原始 HTML）。

- **工厂注入**：`makeWebFetchTool(deps: { client: OpenAI; onUsage })`，与 `makeAgentTool`（agent.ts:36）同款模式——工具内部需调模型，client 由 registry 装配时注入。
- 入参 zod：`{ url: string, prompt: string }`（prompt 是「针对该页要回答/抽取什么」，CC 式下是必填）。
- 实现：
  1. undici `fetch`（复用 `api.ts` 的 ProxyAgent dispatcher，走 `127.0.0.1:8118`）GET url，传 `ctx.signal`（Esc 可中断）。
  2. 按 content-type：HTML 剥 `<script>/<style>` + 去标签 + 折叠空白；非 HTML 直接文本。截断到 ~30k 字符喂模型（控成本，超出标注）。
  3. 复用 `runLoop(messages, { tools: [], model: SUB_MODEL, thinking: false, maxTurns: 1, ... })`（与 agent.ts 同款，自带 thinking 关闭/重试/代理；无工具→模型直接作答）。system「你从网页内容中按用户问题提取/总结，只依据给定内容、不编造」+ user「URL:{url}\n问题:{prompt}\n\n内容:\n{正文}」→ 取最后一条 assistant content。
  4. `turn_end` 时 `deps.onUsage(usage, SUB_MODEL)` 计入会话花费。
- 非 2xx / 超时 / 非 http(s) 协议 → 返回错误字符串（不抛，喂回主模型）。
- **权限**：`isReadOnly:false`、`needsPermission` 返回 host 描述 → 复用现有闸门（可弹窗/可 always-allow per host），因访问外网有副作用 + 泄漏 URL + 产生 token 花费。headless 按 yolo/已存规则。
- 注册进 `src/tools/registry.ts`（registry 须能拿到 client + onUsage 来构造，参照 agent 工具的装配处）。

### 7. README（公开向）

安装（`npm i -g ds-code`，命令 `deepcode`）、配 key（首跑向导 / 或 env `DEEPSEEK_API_KEY` / 或 `~/.deepcode/config.json`）、用法（交互 TUI / `-p "<任务>"` headless / `--json` / `@文件` / `!shell` / 斜杠命令）、模型（flash↔pro、/think）、代理须知（本机 127.0.0.1:8118）、roadmap（M6 done、M7=/rewind+可写 subagent+worktree）。

## 测试

- `config.ts`：env 优先 / 仅配置文件 / 都无 / 坏 JSON 降级；`saveApiKey` 合并字段 + 权限位。
- `version.ts`：导出非空、与 package.json 一致。
- `webfetch.ts`：mock fetch + mock client → HTML 剥离+截断、子模型按 prompt 作答（断言 content 进了 user 消息）、非 200 错误、非 http(s) 拒绝、onUsage 计费、权限闸门（needsPermission 返回 host）。
- `Setup.tsx`：ink-testing — 无 key 渲染向导、输入回车后调 saveApiKey。
- 删 repl 相关测试。
- **集成验收**：`npm run build` 出 dist 且 `node dist/index.js` 起 TUI；`npm pack` 产物只含 dist+README+package.json（无 src/test）；首跑冒烟（无 key→向导→写 config→二次启动直进）；现有 210 测试不回归 + typecheck 干净。

## 排序（子任务依赖链）

1. 构建管线 + 版本号源头（地基：能出 dist、能跑 node dist）
2. `config.ts` + 改 `api.ts` 读取（key 解析）
3. `Setup.tsx` 首跑向导（依赖 2）
4. 删 `repl.ts`/`--plain`（独立，可早做）
5. WebFetch 工具（独立）
6. README
7. 集成验收（build/pack/首跑冒烟 + 回归）

## 风险 / 权衡

- **shebang 保留**：确认 tsc(target ES2022,NodeNext) 对 `src/index.ts` 首行 `#!` 的 emit 行为；若不保留则 build 后用脚本 prepend（兜底）。
- **package.json 运行时读取**：dist 在 `dist/index.js`，`package.json` 在包根 → 路径用 `new URL('../package.json', import.meta.url)`，build 后层级正确。
- **WebFetch 安全**：仅 GET、限长、权限闸门、走代理；不跟随非 http(s) 协议；SSRF 面交由权限闸门 + 用户判断（个人工具，不做企业级域名白名单）。
- **删 repl 破坏性**：去掉 `--plain` 逃生舱；若未来某终端 ink 出问题，回退手段是 headless `-p` 或修 ink，不再有 readline 后路（用户已知情同意）。
