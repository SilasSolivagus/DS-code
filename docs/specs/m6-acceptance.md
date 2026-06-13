# M6 集成验收报告

**日期：** 2026-06-13  
**分支：** m6  
**版本：** @silassolivagus/deepcode@0.6.0  
**验收结论：** DONE ✅

---

## 范围

M6 目标：**可发布里程碑** — 构建管线、apiKey 配置、首跑向导、WebFetch、README。

- **纳入 M6：** tsc→dist 管线、settings.json apiKey、首跑 TUI 向导（无 repl/--plain）、WebFetch 工具、公开 README
- **推迟至 M7：** /rewind 回滚、writable subagent + git worktree

---

## M6 提交清单

```
43898ef docs(M6): 修正 README /model 说明（无参 flash↔pro 切换、真名 deepseek-v4-pro）
11993b9 docs(M6): 公开向 README（安装/配 key/用法/模型/roadmap）
777ee09 feat(M6): WebFetch 工具（CC 式：抓取+flash 按问题作答，权限闸门+计费）
7212fd4 feat(M6): 首跑向导（无 key→TUI 配 key 写 settings）+ 删 --plain/repl 单一路径
73c2bd3 refactor(M6): createClient 单次 loadSettings 复用（apiKey+baseURL）
4cd9a3f feat(M6): apiKey 并入 settings.json，createClient env 优先 settings 兜底
23519ed feat(M6): tsc→dist 构建管线 + 版本号源头（banner 显 v{version}）
```

---

## Step 1 — 打包文件清单（npm pack --dry-run）

仅含 `dist/**`、`README.md`、`package.json`，无 `src/`、`test/`、`docs/`、`bench/`、`node_modules/`。

```
dist/api.js             dist/tools/agent.js        dist/tui/App.js
dist/commands.js        dist/tools/bash.js         dist/tui/components/Banner.js
dist/compact.js         dist/tools/edit.js         dist/tui/components/InputBox.js
dist/config.js          dist/tools/glob.js         dist/tui/components/PermissionDialog.js
dist/headless.js        dist/tools/grep.js         dist/tui/components/SelectList.js
dist/index.js           dist/tools/index.js        dist/tui/components/Spinner.js
dist/loop.js            dist/tools/read.js         dist/tui/components/StatusFooter.js
dist/permissions.js     dist/tools/todowrite.js    dist/tui/components/Suggestions.js
dist/pricing.js         dist/tools/types.js        dist/tui/components/ToolLine.js
dist/prompt.js          dist/tools/webfetch.js     dist/tui/components/Transcript.js
                        dist/tools/write.js        dist/tui/diffPreview.js
dist/session.js                                    dist/tui/index.js
dist/text.js                                       dist/tui/markdown.js
dist/todo.js                                       dist/tui/setup.js
dist/version.js                                    dist/tui/suggest.js
                                                   dist/tui/theme.js
                                                   dist/tui/toolArg.js
                                                   dist/tui/useChat.js
README.md
package.json
```

总文件数：45（干净 build 后；删 repl.ts 前的旧 dist 会多一个 dist/repl.js），打包大小 ~54 kB。

---

## Step 2 — bin 入口加载验证

命令：
```
env -u DEEPSEEK_API_KEY HOME=$(mktemp -d) node dist/index.js -p "x" 2>&1 | head -5
```

输出：
```
缺少 DeepSeek API key。运行 deepcode 进入首跑向导配置，或 export DEEPSEEK_API_KEY=sk-...
```

退出码：1（非零）。✅ 入口线路 + key 解析正确，无需网络。

---

## Step 3 — 首跑向导 pty 冒烟

脚本：`/tmp/ds-smoke/m6-setup.py`

```
=== M6 首跑冒烟 ===
  ✓ 首跑出现向导(API key 提示)
  ✓ settings.json 写出
  ✓ apiKey 写入
  ✓ 权限 600
  ✓ 二次启动不再出现向导
  ✓ 二次启动进 TUI 欢迎框
6/6 通过
```

**冒烟脚本说明：** 原始脚本中 `os.write(master, b'sk-pty-test\r')` 一次性发送字符+回车，
PTY 输出缓冲未排空导致 node 事件循环未处理完字符输入就收到 Enter 而失败。
修正方式：字符逐字节发送（50ms 间隔）后增加 `pump(1)` 排空回显，再发 `\r`。
向导本身无 bug，issue 纯属冒烟脚本 PTY 写入时序问题。

---

## Step 4 — 全量回归

```
Test Files  35 passed (35)
      Tests  219 passed (219)
   Duration  1.37s
```

TypeScript 类型检查：`tsc --noEmit` 无错误。✅

---

## 发布结果 ✅ 已发布

2026-06-14 **已发布 npm：`@silassolivagus/deepcode@0.6.0`**，命令 `deepcode`。
端到端验证通过：`npm i -g @silassolivagus/deepcode` 全局安装 → `deepcode` 启动，
欢迎页正确显示 `🐳 deepcode v0.6.0`（version.ts 在已发布 dist 中读对 package.json）。

执行记录：
1. bump 0.1.0 → 0.6.0 + 补 package.json `description` ✅
2. tag `v0.6.0-m6`（annotated，接 m1–m5 序列）✅
3. **包名**：无 scope 的 `ds-code` 被 npm 仿冒过滤器拦（与 `ts-node` 太像），改用 scoped `@silassolivagus/deepcode`（命令名仍 `deepcode`，bin 解耦）✅
4. `npm publish --access public` ✅
5. `npm i -g @silassolivagus/deepcode && deepcode` 验证通过 ✅

---

## 带入 M7 事项

| 事项 | 说明 |
|------|------|
| `/rewind` 回滚 | 回退到任意历史轮次，重新执行 |
| Writable subagent + worktree | 可写子 agent 在独立 git worktree 中执行，隔离主分支 |

---

## 轻量后续（不阻塞发布）

| 问题 | 优先级 |
|------|--------|
| `package.json` 缺 `license` 字段 | 发布时 npm warn（未失败）；待用户定协议（MIT 等）后补 |
| `WebFetch` 中 `SUB_MODEL` 常量与 `agent.ts` 重复 | 可选 DRY（低风险） |
| `WebFetch` 截断分支未有单测 | 低风险，可补测 |
