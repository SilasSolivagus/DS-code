# deepcode P2 · `/commit` + `/commit-push-pr` 内置命令设计 spec

**日期**：2026-06-24
**来源**：CC v2.1.121 实读（opus 专家逐字 grep `/opt/homebrew/lib/node_modules/@anthropic-ai/.claude-code-2DTsDk1V/cli.js`，函数 `dFY`=/commit、`X9q`=/commit-push-pr、`Pv6`=trailer）+ deepcode 现状实读。
**前置**：Prompt 对齐批 P1 已完成（gap 分析 commit/PR 那件拆来本批）。

## 背景与动机

deepcode 当前**完全没有** commit/PR 工作流指引（gap 分析 HIGH#2）。CC 把它做成 `/commit` 和 `/commit-push-pr` 两个 slash-command feature prompt：用 `!`cmd`` 预跑 git 命令、注入 Git Safety Protocol + 编排指令，驱动模型写 message 并提交。本批在 deepcode 复刻这两个命令。

## 关键架构约束（实读确认）

- deepcode **不支持** CC 的 skill 身体内 `!`cmd`` 自动预跑（`src/skillsLoader.ts` 只做 `$ARGUMENTS` 文本替换）。
- deepcode **无捆绑-skill 加载器**（skills 只从用户目录加载，不从 deepcode 安装目录）。
- 故两命令做成**硬编码内置命令**（像现有 18 个 `/model` 等），在 `src/tui/useChat.ts` 的 `send`（`:845`）里加分支。
- deepcode 有 `runBang(cmd, cwd)`（`src/tui/useChat.ts:62`，execSync 同步、30s 超时、输出截 20KB），可在命令处理器里**直接预跑 git**（不经模型 Bash 工具，故预跑的只读命令**不弹权限窗**）。

## 设计

### 数据流（两命令同构）

```
用户输 /commit
  → 命令处理器（useChat send 分支）
  → runBang 预跑 git 命令集（顺序跑，本地快）
  → 空 diff 判断：git status --porcelain 空 → notice「无改动可提交」+ return（早退，不触发 turn）
  → 注入 <git-context> context 消息（messages.push，非 transcript）
  → 注入 guidance 消息（COMMIT_GUIDANCE / COMMIT_PUSH_PR_GUIDANCE）
  → runTurn 触发模型（模型据 context+guidance 写 message、调 Bash 跑 git commit[/push/gh pr create]）
  → 模型写动作经 checkPermission 正常弹窗（commit/push/pr=共享状态动作，弹窗确认符合谨慎原则）
```

> 预跑（我们跑，只读，不弹窗）vs 模型写动作（弹窗）的分工是本设计的权限模型，无需预授权。

### 模块边界

**新建纯逻辑模块 `src/commitGuidance.ts`**（无 I/O，全可测）：
- `COMMIT_GUIDANCE: string` — /commit 的 Safety Protocol + 编排 + trailer 指令（中文，镜像 CC `dFY`）
- `COMMIT_PUSH_PR_GUIDANCE: string` — /commit-push-pr 的（中文，镜像 CC `X9q`）
- `buildCommitContext(o: { status: string; diff: string; branch: string; log: string }): string` — 拼 `<git-context>` 纯函数
- `buildPrContext(o: { status: string; diff: string; branch: string; baseDiff: string; existingPr: string }): string` — /commit-push-pr 的 context 纯函数
- `isEmptyDiff(porcelain: string): boolean` — `porcelain.trim() === ''`（空 diff 判断纯函数）
- `resolveBaseBranch(cwd: string): string` — 解析 base 分支（`git symbolic-ref refs/remotes/origin/HEAD` → `origin/main` 取末段；失败回退 `main`）。**这条有 I/O（execSync），但单独小函数易测/易 mock。**

**接线 `src/tui/useChat.ts send`**：两个 `if (line === '/commit')` / `if (line === '/commit-push-pr')` 分支，各自预跑→空判→注入→runTurn。HELP_TEXT 加两行。

### `/commit` — 预跑命令集（逐字命中 CC `dFY`）

```
git status
git diff HEAD
git branch --show-current
git log --oneline -10
```

`buildCommitContext` 输出：
```
<git-context>
## 当前 git 状态（git status）
{status}

## 当前改动（git diff HEAD，已暂存+未暂存）
{diff}

## 当前分支（git branch --show-current）
{branch}

## 近期提交（git log --oneline -10）
{log}
</git-context>
```

### `COMMIT_GUIDANCE` 内容（中文，镜像 CC `dFY` 全文 + 吸收 system 级两条）

```
请根据上面的 <git-context> 创建一个 git commit。

## Git 安全准则
- 绝不修改 git config。
- 绝不跳过 hooks（--no-verify、--no-gpg-sign 等），除非用户明确要求。
- 关键：始终创建新 commit；绝不用 git commit --amend，除非用户明确要求。
- 不要提交可能含密钥的文件（.env、credentials.json 等）；若用户明确要求提交这类文件，先警告再说。
- 没有改动（无未跟踪文件也无修改）时不要创建空 commit。
- 绝不使用带 -i 的 git 命令（如 git rebase -i、git add -i），它们需要交互输入，这里不支持。
- 暂存文件时优先按文件名逐个 add，不要用 git add -A 或 git add .，以免误纳入敏感文件或大二进制。

## 你的任务
基于上面的改动，创建单个 git commit：
1. 分析所有改动并起草 commit message：
   - 参照上面「近期提交」跟随本仓库的 message 风格。
   - 概括改动性质（新功能/增强/修复/重构/测试/文档等）。
   - 用词准确：「add」=全新功能，「update」=增强现有功能，「fix」=修 bug。
   - 起草简洁（1-2 句）的 message，聚焦「为何」而非「改了什么」。
2. 暂存相关文件，并用 HEREDOC 语法创建 commit（保证多行格式正确、防 shell 转义）：
   git commit -m "$(cat <<'EOF'
   这里是 commit message。

   Co-Authored-By: deepcode <noreply@dirctable.com>
   EOF
   )"
3. commit 完成后跑 git status 确认成功。若因 pre-commit hook 失败，先修问题再创建新 commit（不要 --amend）。

你可以在单次回复里并行调用多个工具。请用一条消息完成暂存与提交。不要使用其它工具或做其它事。除了这些工具调用，不要发送任何其它文字或消息。
```

> trailer = commit body 只这一行 `Co-Authored-By: deepcode <noreply@dirctable.com>`，**不加「Generated with」**（CC commit body 也只有 Co-Authored-By；🤖 footer 只进 PR）。

### `/commit-push-pr` — 预跑命令集（CC `X9q`，比 /commit 多 2 条 + base 解析）

```
git status
git diff HEAD
git branch --show-current
git diff <base>...HEAD          # 三点 diff，base = resolveBaseBranch(cwd)
gh pr view --json number 2>/dev/null || true   # 检测 PR 是否已存在
```

`resolveBaseBranch`：`git symbolic-ref refs/remotes/origin/HEAD`（如 `refs/remotes/origin/main`）取末段；execSync 失败 → 回退 `'main'`。**不硬编码 main。**

`buildPrContext` 输出同 `<git-context>` 风格，含 base diff 段 + `## 是否已存在 PR（gh pr view）` 段。

### `COMMIT_PUSH_PR_GUIDANCE` 内容（中文，镜像 CC `X9q`，去 CC 专属）

```
请根据上面的 <git-context> 创建 commit、推送分支，并创建或更新 Pull Request。

## Git 安全准则
- 绝不修改 git config。
- 绝不运行破坏性/不可逆的 git 命令（push --force、hard reset 等），除非用户明确要求。
- 绝不跳过 hooks（--no-verify 等），除非用户明确要求。
- 绝不 force-push 到 main/master；若用户要求，先警告。
- 不要提交可能含密钥的文件（.env、credentials.json 等）。
- 绝不使用带 -i 的交互式 git 命令。

## 你的任务
分析将进入这个 PR 的所有改动——务必看上面 git diff <base>...HEAD 输出里的全部 commit（不只是最新一个）。然后：
1. 若当前在 base 分支上，先创建新分支（分支名形如 你的名字/feature-name；拿不准就问用户）。
2. 用 HEREDOC 语法创建单个 commit（message 末尾带 Co-Authored-By: deepcode <noreply@dirctable.com>）。
3. 把分支 push 到 origin。
4. 检查上面 gh pr view 输出：若该分支已有 PR，用 gh pr edit 更新标题和正文以反映当前改动；否则用 gh pr create 创建（正文用 HEREDOC）。
   - 重要：PR 标题保持简短（70 字符以内），细节放正文。
   - PR 正文模板：
     ## Summary
     <1-3 条要点>

     ## Test plan
     [测试该 PR 的 markdown 复选框清单]

     ## Changelog
     [若有面向用户的改动，在此加一条 changelog；否则删除本节。]

     🤖 由 deepcode 生成
5. 若 gh 不可用（命令报错），告知用户需要安装并登录 gh CLI，不要硬闯。

你可以在单次回复里并行调用多个工具，请用一条消息完成以上全部。完成后返回 PR 的 URL。除了这些工具调用与最终 PR URL，不要发送其它文字。
```

> 去掉的 CC 专属：`--reviewer anthropics/claude-code`、`--add-reviewer`、Slack 通知、SAFEUSER 环境变量（分支名前缀用「你的名字」占位或让模型问）。PR trailer 本地化为「🤖 由 deepcode 生成」（去掉 Claude Code 链接）。

### 空 diff 早退（超 CC 优化）

预跑阶段额外跑一条 `git status --porcelain`，其输出经 `isEmptyDiff` 判定为空时：
- `/commit`：`notice('info', '没有可提交的改动')` + return，不触发 turn。
- `/commit-push-pr`：同样早退（无改动无 PR 可建）。

省 token，比 CC（靠指令让模型自己判断）更早拦截。

## 测试

`test/commitGuidance.test.ts`（纯函数）：
- `COMMIT_GUIDANCE` 含 6 条 Safety Protocol 关键词（git config / --no-verify / --amend / .env / 空 commit / -i）+ 「参照…风格」+ HEREDOC + `Co-Authored-By: deepcode` + 「不要发送任何其它文字」。
- `COMMIT_GUIDANCE` **不含**「Generated with」/「🤖」（commit body 不带 footer）。
- `COMMIT_PUSH_PR_GUIDANCE` 含 force-push main 红线 + gh pr edit/create 二分 + ## Summary/## Test plan/## Changelog + 「🤖 由 deepcode 生成」+ 「所有改动…不只最新」。
- `buildCommitContext` / `buildPrContext`：给定输入产出含各段 + `<git-context>` 包裹。
- `isEmptyDiff`：空串/纯空白→true，有内容→false。
- `resolveBaseBranch`：mock execSync 返回 `refs/remotes/origin/develop`→`develop`；execSync throw→`main`。

接线（useChat send 分支）：纯逻辑难单测（大闭包），靠 tsc + 批末真机冒烟。

## 模块边界小结

- `src/commitGuidance.ts`：两 guidance 常量 + 3 个 context/判断纯函数 + resolveBaseBranch（唯一 I/O，小而可 mock）。一个清晰职责=「生成 commit/PR 的预跑上下文与指令文本」。
- `src/tui/useChat.ts`：两个 send 分支编排（预跑→空判→注入→turn）+ HELP_TEXT 两行。

## 风险

1. **权限弹窗体验**：模型每个写动作（commit/push/gh pr create）弹窗。这是刻意的（共享状态动作该确认），但用户连续 commit 会反复弹——可后续加「always」规则记忆缓解，本批不预授权。
2. **gh 依赖**：`/commit-push-pr` 需 gh CLI 已装并登录；guidance 已指示 gh 不可用时告知用户。
3. **base 分支解析**：`git symbolic-ref refs/remotes/origin/HEAD` 在未设 origin/HEAD 的仓库会失败→回退 main；可接受（用户多在标准 remote 仓库用 PR）。
4. **真机冒烟必做**：两命令端到端（预跑注入正确、模型据此提交、trailer 进 commit、空 diff 早退、PR create/edit 二分）需真机验证——本批**单独真机冒烟**（不与 TUI 批合并，因这是独立命令逻辑、不碰 TUI 渲染）。

## 不做（本批外）

- 预授权 git 写动作（保持弹窗）。
- commit message 的本地 LLM 预生成（直接让主模型在 turn 里写）。
- PR trailer 的 X%/N-shotted 遥测增强（CC 专属）。
- 把 commit/PR 指引塞进系统提示（CC 也不放系统提示，放按需命令）。
