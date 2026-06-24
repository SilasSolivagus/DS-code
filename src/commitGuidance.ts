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
