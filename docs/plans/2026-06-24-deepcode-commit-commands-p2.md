# deepcode P2 · `/commit` + `/commit-push-pr` 内置命令实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 deepcode 加 `/commit` 和 `/commit-push-pr` 两个硬编码内置命令：用 `runBang` 预跑 git 命令，注入 `<git-context>` + guidance，触发模型写 message 并提交（/commit-push-pr 还 push + 建/改 PR）。

**Architecture:** 新建纯逻辑模块 `src/commitGuidance.ts`（两 guidance 常量 + context/判断纯函数 + resolveBaseBranch），在 `src/tui/useChat.ts` 的 `send` 里加两个内置命令分支编排（预跑→空 diff 早退→注入消息→runTurn）。guidance 中文、镜像 CC v2.1.121 真实文本。

**Tech Stack:** TypeScript/ESM、vitest。零新依赖（复用现有 `runBang`/`execSync`）。

## Global Constraints

- **commit trailer** = commit body 末尾只一行 `Co-Authored-By: deepcode <noreply@dirctable.com>`，**不加「Generated with」/🤖**（🤖 footer 只进 PR body）。
- **PR trailer** = `🤖 由 deepcode 生成`（去掉 Claude Code 链接，本地化）。
- **/commit 没有 force-push 红线**（它不 push）；force-push main + destructive 红线只属于 `/commit-push-pr`。
- **预跑命令逐字**：/commit = `git status` / `git diff HEAD` / `git branch --show-current` / `git log --oneline -10`；/commit-push-pr 多 `git diff <base>...HEAD`（三点）+ `gh pr view --json number 2>/dev/null || true`。
- **base 分支不硬编码 main**：`resolveBaseBranch` 用 `git symbolic-ref refs/remotes/origin/HEAD` 取末段，失败回退 `'main'`。
- **guidance 末尾**：照抄 CC「纯调工具不输出文字」（/commit 末句「除了这些工具调用，不要发送任何其它文字或消息」；/commit-push-pr「除了这些工具调用与最终 PR URL，不要发送其它文字」）。
- **权限模型**：预跑（runBang 直接跑、只读、不弹窗）vs 模型写动作（commit/push/pr 经 checkPermission 弹窗）。**不预授权**。
- **去掉 CC 专属**：`--reviewer anthropics/claude-code`、Slack、SAFEUSER。
- 测试运行：`npx vitest run <file>` 单文件；`npx vitest run` 全量；`npx tsc --noEmit`；`npm run build`。
- 已知 flaky：`test/hooks.test.ts` 偶发 EPIPE（pre-existing，vitest exit 0 不计失败）。
- 本批做完**单独真机冒烟**（独立命令逻辑，不碰 TUI 渲染，不与 TUI 批合并）。

---

## 文件结构

**新建：**
- `src/commitGuidance.ts` — guidance 常量 + 纯函数（Task 1-3）
- `test/commitGuidance.test.ts` — 纯函数测试

**修改：**
- `src/tui/useChat.ts` — `send` 加两个内置命令分支 + HELP_TEXT 两行（Task 4-5）

---

## 实施次序

Task 1-3 建 `commitGuidance.ts` 的各部分（常量/context 函数/resolveBaseBranch+isEmptyDiff），纯逻辑 TDD。Task 4 接 `/commit`，Task 5 接 `/commit-push-pr`。接线任务靠 tsc/build + 批末真机冒烟。

---

### Task 1: guidance 常量（COMMIT_GUIDANCE + COMMIT_PUSH_PR_GUIDANCE）

**Files:**
- Create: `src/commitGuidance.ts`
- Test: `test/commitGuidance.test.ts`

**Interfaces:**
- Produces: `export const COMMIT_GUIDANCE: string`、`export const COMMIT_PUSH_PR_GUIDANCE: string`

- [ ] **Step 1: 写失败测试**

```ts
// test/commitGuidance.test.ts
import { describe, it, expect } from 'vitest'
import { COMMIT_GUIDANCE, COMMIT_PUSH_PR_GUIDANCE } from '../src/commitGuidance.js'

describe('COMMIT_GUIDANCE', () => {
  it('含 6 条 Safety Protocol 关键词', () => {
    for (const k of ['git config', '--no-verify', '--amend', '.env', '空 commit', '-i']) {
      expect(COMMIT_GUIDANCE).toContain(k)
    }
  })
  it('含「参照…风格」编排 + HEREDOC + add/update/fix 语义', () => {
    expect(COMMIT_GUIDANCE).toContain('风格')
    expect(COMMIT_GUIDANCE).toContain('HEREDOC')
    expect(COMMIT_GUIDANCE).toContain('add')
  })
  it('含 commit 后验证 git status', () => {
    expect(COMMIT_GUIDANCE).toContain('确认成功')
  })
  it('trailer = Co-Authored-By: deepcode <noreply@dirctable.com>', () => {
    expect(COMMIT_GUIDANCE).toContain('Co-Authored-By: deepcode <noreply@dirctable.com>')
  })
  it('commit body 不含 Generated with / 🤖（只进 PR）', () => {
    expect(COMMIT_GUIDANCE).not.toContain('Generated with')
    expect(COMMIT_GUIDANCE).not.toContain('🤖')
  })
  it('末尾纯调工具不输出文字', () => {
    expect(COMMIT_GUIDANCE).toContain('不要发送任何其它文字')
  })
})

describe('COMMIT_PUSH_PR_GUIDANCE', () => {
  it('含 force-push main 红线', () => {
    expect(COMMIT_PUSH_PR_GUIDANCE).toContain('force-push 到 main')
  })
  it('含 gh pr edit/create 二分', () => {
    expect(COMMIT_PUSH_PR_GUIDANCE).toContain('gh pr edit')
    expect(COMMIT_PUSH_PR_GUIDANCE).toContain('gh pr create')
  })
  it('PR body 模板含 Summary/Test plan/Changelog', () => {
    expect(COMMIT_PUSH_PR_GUIDANCE).toContain('## Summary')
    expect(COMMIT_PUSH_PR_GUIDANCE).toContain('## Test plan')
    expect(COMMIT_PUSH_PR_GUIDANCE).toContain('## Changelog')
  })
  it('PR trailer = 🤖 由 deepcode 生成', () => {
    expect(COMMIT_PUSH_PR_GUIDANCE).toContain('🤖 由 deepcode 生成')
  })
  it('含「分析所有 commit 不只最新」', () => {
    expect(COMMIT_PUSH_PR_GUIDANCE).toContain('不只是最新')
  })
  it('含 commit trailer 同款邮箱', () => {
    expect(COMMIT_PUSH_PR_GUIDANCE).toContain('Co-Authored-By: deepcode <noreply@dirctable.com>')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/commitGuidance.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

创建 `src/commitGuidance.ts`，先写两个常量（context 函数 Task 2 加、resolveBaseBranch/isEmptyDiff Task 3 加）：

```ts
// src/commitGuidance.ts —— /commit 与 /commit-push-pr 的预跑上下文与指令文本（镜像 CC v2.1.121）

export const COMMIT_GUIDANCE = `请根据上面的 <git-context> 创建一个 git commit。

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

你可以在单次回复里并行调用多个工具。请用一条消息完成暂存与提交。不要使用其它工具或做其它事。除了这些工具调用，不要发送任何其它文字或消息。`

export const COMMIT_PUSH_PR_GUIDANCE = `请根据上面的 <git-context> 创建 commit、推送分支，并创建或更新 Pull Request。

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

你可以在单次回复里并行调用多个工具，请用一条消息完成以上全部。完成后返回 PR 的 URL。除了这些工具调用与最终 PR URL，不要发送其它文字。`
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/commitGuidance.test.ts && npx tsc --noEmit`
Expected: PASS + 类型干净

- [ ] **Step 5: Commit**

```bash
git add src/commitGuidance.ts test/commitGuidance.test.ts
git commit -m "feat(commit-p2): COMMIT_GUIDANCE + COMMIT_PUSH_PR_GUIDANCE 常量（镜像 CC v2.1.121）"
```

---

### Task 2: context 拼装纯函数（buildCommitContext + buildPrContext）

**Files:**
- Modify: `src/commitGuidance.ts`
- Test: `test/commitGuidance.test.ts`（追加）

**Interfaces:**
- Produces:
  - `export function buildCommitContext(o: { status: string; diff: string; branch: string; log: string }): string`
  - `export function buildPrContext(o: { status: string; diff: string; branch: string; baseDiff: string; existingPr: string }): string`

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 test/commitGuidance.test.ts
import { buildCommitContext, buildPrContext } from '../src/commitGuidance.js'

describe('buildCommitContext', () => {
  it('用 <git-context> 包裹且含四段输出', () => {
    const c = buildCommitContext({ status: 'ST', diff: 'DF', branch: 'BR', log: 'LG' })
    expect(c.startsWith('<git-context>')).toBe(true)
    expect(c.trimEnd().endsWith('</git-context>')).toBe(true)
    expect(c).toContain('ST')
    expect(c).toContain('DF')
    expect(c).toContain('BR')
    expect(c).toContain('LG')
  })
})

describe('buildPrContext', () => {
  it('含 base diff 段与已存在 PR 段', () => {
    const c = buildPrContext({ status: 'ST', diff: 'DF', branch: 'BR', baseDiff: 'BD', existingPr: 'PR' })
    expect(c.startsWith('<git-context>')).toBe(true)
    expect(c).toContain('BD')
    expect(c).toContain('PR')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/commitGuidance.test.ts`
Expected: FAIL — 函数未导出

- [ ] **Step 3: 实现**

在 `src/commitGuidance.ts` 追加：

```ts
export function buildCommitContext(o: { status: string; diff: string; branch: string; log: string }): string {
  return `<git-context>
## 当前 git 状态（git status）
${o.status}

## 当前改动（git diff HEAD，已暂存+未暂存）
${o.diff}

## 当前分支（git branch --show-current）
${o.branch}

## 近期提交（git log --oneline -10）
${o.log}
</git-context>`
}

export function buildPrContext(o: { status: string; diff: string; branch: string; baseDiff: string; existingPr: string }): string {
  return `<git-context>
## 当前 git 状态（git status）
${o.status}

## 当前改动（git diff HEAD）
${o.diff}

## 当前分支（git branch --show-current）
${o.branch}

## 分支自分叉点起的全部改动（git diff base...HEAD）
${o.baseDiff}

## 是否已存在 PR（gh pr view --json number）
${o.existingPr}
</git-context>`
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/commitGuidance.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commitGuidance.ts test/commitGuidance.test.ts
git commit -m "feat(commit-p2): buildCommitContext/buildPrContext 拼 <git-context> 纯函数"
```

---

### Task 3: isEmptyDiff + resolveBaseBranch

**Files:**
- Modify: `src/commitGuidance.ts`
- Test: `test/commitGuidance.test.ts`（追加）

**Interfaces:**
- Produces:
  - `export function isEmptyDiff(porcelain: string): boolean`
  - `export function resolveBaseBranch(cwd: string): string`（execSync I/O，失败回退 `'main'`）

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 test/commitGuidance.test.ts —— resolveBaseBranch 需 mock child_process
import { vi } from 'vitest'
import { isEmptyDiff, resolveBaseBranch } from '../src/commitGuidance.js'

describe('isEmptyDiff', () => {
  it('空串/纯空白→true', () => {
    expect(isEmptyDiff('')).toBe(true)
    expect(isEmptyDiff('   \n  ')).toBe(true)
  })
  it('有内容→false', () => {
    expect(isEmptyDiff(' M src/x.ts')).toBe(false)
  })
})

describe('resolveBaseBranch', () => {
  it('解析 symbolic-ref 末段', () => {
    const spy = vi.spyOn(await import('node:child_process'), 'execSync')
      .mockReturnValue(Buffer.from('refs/remotes/origin/develop\n'))
    expect(resolveBaseBranch('/x')).toBe('develop')
    spy.mockRestore()
  })
  it('execSync throw → 回退 main', () => {
    const spy = vi.spyOn(await import('node:child_process'), 'execSync')
      .mockImplementation(() => { throw new Error('no origin/HEAD') })
    expect(resolveBaseBranch('/x')).toBe('main')
    spy.mockRestore()
  })
})
```

> 注：若 `vi.spyOn` import 形态在本仓库不便，实现者可改用 `vi.mock('node:child_process', ...)` 顶层 mock，与 `test/config.test.ts` 的 os mock 范式一致——核心断言不变（develop / main 两路）。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/commitGuidance.test.ts`
Expected: FAIL — 函数未导出

- [ ] **Step 3: 实现**

在 `src/commitGuidance.ts` 顶部加 import，并追加：

```ts
import { execSync } from 'node:child_process'

export function isEmptyDiff(porcelain: string): boolean {
  return porcelain.trim() === ''
}

/** 解析 base 分支：git symbolic-ref refs/remotes/origin/HEAD 取末段；失败回退 main。不硬编码 main。 */
export function resolveBaseBranch(cwd: string): string {
  try {
    const out = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim()
    const seg = out.split('/').pop()
    return seg || 'main'
  } catch {
    return 'main'
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/commitGuidance.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commitGuidance.ts test/commitGuidance.test.ts
git commit -m "feat(commit-p2): isEmptyDiff 空判 + resolveBaseBranch（symbolic-ref 末段，回退 main）"
```

---

### Task 4: `/commit` 内置命令接线

**Files:**
- Modify: `src/tui/useChat.ts`（`send` 内置命令区 ~855-1051 加分支；HELP_TEXT ~214）

**Interfaces:**
- Consumes: `COMMIT_GUIDANCE`, `buildCommitContext`, `isEmptyDiff`（commitGuidance.ts）；`runBang`（同文件 :62）；`messages`/`session.appendMessage`/`runTurn`/`notice`/`cwd`（闭包内）

- [ ] **Step 1: 加 import + 分支 + HELP**

`src/tui/useChat.ts` 顶部 import 区加：
```ts
import { COMMIT_GUIDANCE, COMMIT_PUSH_PR_GUIDANCE, buildCommitContext, buildPrContext, isEmptyDiff, resolveBaseBranch } from '../commitGuidance.js'
```

在 `send` 的内置命令区（与 `/model` 等同级，`if (line === '/help')` 附近、`runTurn` 调用之前）加 `/commit` 分支：

```ts
if (line === '/commit') {
  const status = runBang('git status', cwd).output
  if (isEmptyDiff(runBang('git status --porcelain', cwd).output)) {
    notice('info', '没有可提交的改动')
    return
  }
  const diff = runBang('git diff HEAD', cwd).output
  const branch = runBang('git branch --show-current', cwd).output
  const log = runBang('git log --oneline -10', cwd).output
  const ctxMsg = { role: 'user' as const, content: buildCommitContext({ status, diff, branch, log }) }
  messages.push(ctxMsg)
  session.appendMessage(ctxMsg)
  await runTurn(line, COMMIT_GUIDANCE)
  return
}
```

更新 HELP_TEXT（`src/tui/useChat.ts:214` 那个多行字符串）插入一行：
```
/commit 生成并创建 git commit（预跑 git 状态+遵循仓库风格，带 Co-Authored-By: deepcode）
```

> 说明：①`/commit` 在内置命令区，命中后 `return`，不落到下方 skill/自定义命令分支；②git-context 作为前置 user 消息 push（同 bang 流 `:849-862` 模式），再 runTurn 以 COMMIT_GUIDANCE 作 userText 触发模型；③runTurn 是 async，分支用 `await`（send 已是 async 函数）。

- [ ] **Step 2: 类型检查 + 构建**

Run: `npx tsc --noEmit && npm run build`
Expected: 干净（命令交互归批末真机冒烟）

- [ ] **Step 3: 全量回归**

Run: `npx vitest run`
Expected: 全绿（除 EPIPE flake）。报告计数。

- [ ] **Step 4: Commit**

```bash
git add src/tui/useChat.ts
git commit -m "feat(commit-p2): /commit 内置命令接线（runBang 预跑+空判早退+注入 context+guidance）"
```

---

### Task 5: `/commit-push-pr` 内置命令接线

**Files:**
- Modify: `src/tui/useChat.ts`（`send` 内置命令区加分支；HELP_TEXT）

**Interfaces:**
- Consumes: `COMMIT_PUSH_PR_GUIDANCE`, `buildPrContext`, `isEmptyDiff`, `resolveBaseBranch`（Task 4 已 import）；`runBang`/`messages`/`session`/`runTurn`/`notice`/`cwd`

- [ ] **Step 1: 加分支 + HELP**

在 `send` 内置命令区，`/commit` 分支之后加：

```ts
if (line === '/commit-push-pr') {
  if (isEmptyDiff(runBang('git status --porcelain', cwd).output)) {
    notice('info', '没有可提交的改动')
    return
  }
  const status = runBang('git status', cwd).output
  const diff = runBang('git diff HEAD', cwd).output
  const branch = runBang('git branch --show-current', cwd).output
  const base = resolveBaseBranch(cwd)
  const baseDiff = runBang(`git diff ${base}...HEAD`, cwd).output
  const existingPr = runBang('gh pr view --json number 2>/dev/null || true', cwd).output
  const ctxMsg = { role: 'user' as const, content: buildPrContext({ status, diff, branch, baseDiff, existingPr }) }
  messages.push(ctxMsg)
  session.appendMessage(ctxMsg)
  await runTurn(line, COMMIT_PUSH_PR_GUIDANCE)
  return
}
```

HELP_TEXT 插入一行：
```
/commit-push-pr 提交+推送+创建或更新 PR（## Summary/## Test plan，需 gh CLI）
```

> 说明：①空判用 `git status --porcelain`（与 /commit 一致）；②base 经 `resolveBaseBranch`，三点 diff `git diff base...HEAD`；③`gh pr view ... || true` 即使无 PR 也返回（不抛），existingPr 为空字符串时 guidance 让模型走 create。

- [ ] **Step 2: 类型检查 + 构建**

Run: `npx tsc --noEmit && npm run build`
Expected: 干净

- [ ] **Step 3: 全量回归**

Run: `npx vitest run`
Expected: 全绿（除 EPIPE flake）。报告计数。

- [ ] **Step 4: Commit**

```bash
git add src/tui/useChat.ts
git commit -m "feat(commit-p2): /commit-push-pr 内置命令接线（多预跑 base diff+gh pr view+resolveBaseBranch）"
```

---

## 批末真机冒烟清单（本批单独冒烟，做完跑）

- ① `/commit`：在有改动的仓库跑 → 预跑 git 状态注入 → 模型据近期提交风格写 message → `git commit` 弹权限窗 → commit body 末尾含 `Co-Authored-By: deepcode <noreply@dirctable.com>`、**不含 🤖**
- ② `/commit` 空 diff：干净工作树跑 → 「没有可提交的改动」早退，不触发模型
- ③ `/commit-push-pr`：分支有改动 → 预跑含 base diff + gh pr view → 模型 commit→push→`gh pr create`（PR body 含 ## Summary/## Test plan、末尾「🤖 由 deepcode 生成」）→ 返回 PR URL
- ④ `/commit-push-pr` PR 已存在：同分支再跑 → 模型走 `gh pr edit` 更新而非 create
- ⑤ gh 不可用：临时 PATH 去掉 gh → 模型告知需装/登录 gh，不硬闯
- ⑥ base 分支解析：非 main 默认分支的仓库 → `git diff <真实base>...HEAD` 正确

---

## Self-Review（对照 spec）

**Spec 覆盖**：
- 两 guidance 常量（Task 1）✅；context 纯函数（Task 2）✅；isEmptyDiff + resolveBaseBranch（Task 3）✅
- /commit 预跑 4 条 + 空判 + 注入 + runTurn（Task 4）✅
- /commit-push-pr 多预跑 base diff + gh pr view + resolveBaseBranch（Task 5）✅
- trailer commit 单行无 🤖 / PR 有 🤖（Task 1 测试守卫）✅
- /commit 无 force-push 红线、/commit-push-pr 有（Task 1 两常量分别）✅
- HELP_TEXT 两行（Task 4/5）✅
- 权限不预授权（接线无 allow 注入，模型写动作自然弹窗）✅
- 去 CC 专属（guidance 文本不含 anthropics/claude-code、Slack、SAFEUSER）✅
- 空 diff 早退（Task 4/5 isEmptyDiff 分支）✅

**占位符扫描**：Task 3 测试的 `vi.spyOn` import 形态留了「可改 vi.mock 顶层」的明确替代 + 核心断言（develop/main 两路）固定，非空泛占位。其余步骤含完整代码。

**类型一致性**：`COMMIT_GUIDANCE`/`COMMIT_PUSH_PR_GUIDANCE`/`buildCommitContext`/`buildPrContext`/`isEmptyDiff`/`resolveBaseBranch` 在 Task 1-3 定义、Task 4-5 消费，签名/名称一致。context 函数入参对象字段（status/diff/branch/log；+baseDiff/existingPr）在定义与调用处一致。

**邮箱**：全计划 trailer 用 `noreply@dirctable.com`（用户 2026-06-24 指定），与 spec 一致。
