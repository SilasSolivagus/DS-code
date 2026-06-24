# deepcode ↔ Claude Code — Prompt Gap Analysis

**CC reference:** v2.1.76, extracted under `docs/cc-reference/system-prompts/` (see `00-INDEX.md`).
**deepcode reference:** `src/prompt.ts`, `src/tools/*.ts`, `src/tools/agentTypes.ts`, `src/outputStyles.ts` (read at HEAD, 2026-06-23).

deepcode is a Chinese-language, DeepSeek-backed terminal coding agent. Where a CC
behavior is legitimately inapplicable to deepcode (no vision, Chinese output, no-tty
Bash, single TUI output target, no Anthropic cloud platform), it is marked **[N/A]**
rather than counted as a gap.

---

## 0. TL;DR — top findings

1. **deepcode's system prompt is ~1 page; CC's is ~5 KB of structured behavioral policy.** deepcode collapses everything into one `CODING_RULES` block (`src/prompt.ts:37-48`, 10 bullets). CC splits into 7 named sections with distinct jobs (`# Doing tasks`, `# Executing actions with care`, `# Using your tools`, `# Output efficiency`, `# Tone and style`). The largest single gap is **`# Executing actions with care`** (CC `G5z`) — deepcode has *no* destructive-action / reversibility / blast-radius policy at all.
2. **deepcode has an output-form bias CC does NOT have.** deepcode's `src/prompt.ts:47` bullet pushes "自包含单文件 HTML 优于终端 curses". CC's prompts contain **zero** analogous output-form preference (verdict + evidence in §5). This bias is deepcode-original and should be narrowed.
3. **Tool descriptions are much terser in deepcode** — typically one sentence vs CC's multi-paragraph descriptions with usage rules, examples, and guardrails embedded in the tool itself (Bash, Read, Grep, Task especially). See §2.
4. **deepcode lacks the entire plan-mode / auto-mode reminder machinery and the security/injection posture beyond one bullet.** CC injects ~39 distinct `<system-reminder>` bodies (`system-reminders.md`); deepcode injects exactly one (`PLAN_MODE_GUIDANCE`, `src/prompt.ts:11`).
5. **deepcode's CODING_RULES is genuinely strong on a few axes CC is weaker on** — notably the explicit "完成是用户能用上结果，不是写完文件 → 报告前先实际验证产物" rule (`src/prompt.ts:44`), which is sharper than anything in CC. Keep it.

---

## 1. CC has / deepcode lacks — whole prompts & structural elements

### 1.1 `# Executing actions with care` (CC `G5z`) — **entirely absent in deepcode** [HIGH]
- **CC:** `system-prompts/main-system-prompt.md` §4. A full section on reversibility, blast radius, and confirm-before-acting for destructive/hard-to-reverse/shared-state actions, with concrete example lists (rm -rf, force-push, git reset --hard, pushing code, sending messages) and "authorization stands for the scope specified, not beyond."
- **deepcode:** Nothing equivalent. `CODING_RULES` (`src/prompt.ts:37-48`) has no destructive-action policy, no "confirm before risky/irreversible action," no blast-radius concept. The only adjacent rule is "完成就停下，不做未被要求的额外修改" (scope), which is about *gold-plating*, not *danger*.
- deepcode does have a runtime `deny.ts` / permissions layer, but that's enforcement, not model guidance — the model is never *told* the reversibility heuristic.

### 1.2 `# Using your tools` dedicated-tool routing (CC `f5z`) — **partial in deepcode** [MED]
- **CC:** `main-system-prompt.md` §5. Explicit "Do NOT use Bash when a dedicated tool exists" with a mapping (Read not cat/head/tail/sed; Edit not sed/awk; Write not heredoc/echo; Glob not find/ls; Grep not grep/rg) and a "reserve Bash for system commands" closer. Plus Task/subagent guidance ("avoid duplicating work subagents are doing"), the parallel-tool-call paragraph, and skills-invocation rules.
- **deepcode:** Has the *idea* — `src/prompt.ts:45` ("查找文件用 Glob，搜索内容用 Grep，不要用 Bash 跑 find/grep/cat") and `:39` (parallel read-only calls). But it omits Edit-not-sed / Write-not-heredoc, the "reserve Bash for shell-only operations" framing, and the subagent "don't duplicate work" rule.

### 1.3 `# Output efficiency` / `# Tone and style` (CC `v5z`, `N5z`) — **mostly absent** [MED]
- **CC:** `main-system-prompt.md` §6–7. "Go straight to the point… be extra concise," "Lead with the answer not the reasoning," "If you can say it in one sentence don't use three," "no emojis unless asked," "reference file_path:line_number," and "Do not use a colon before tool calls."
- **deepcode:** opening line "直接、准确、动手解决问题" (`src/prompt.ts:72`) gestures at tone. It HAS the file:line rule (`:43`) — good. It LACKS: explicit conciseness policy, "lead with the answer," no-emoji rule, and the no-colon-before-tool-call rule.

### 1.4 Simplicity sub-list granularity (CC `Z5z` list `A`) — **deepcode is coarser** [LOW]
- **CC:** `main-system-prompt.md` §3. Three dense bullets: no features/refactors/cleanup beyond ask; no comments/docstrings/types on untouched code; no error handling for impossible scenarios, validate only at boundaries; no one-time abstractions; "three similar lines is better than a premature abstraction"; plus "avoid backwards-compat hacks… delete unused completely."
- **deepcode:** `src/prompt.ts:44` compresses this to "完成就停下，不做未被要求的额外修改（不加 scope）". The *intent* matches but CC's specificity (don't add types/comments to code you didn't touch; only validate at boundaries; delete-don't-shim) is lost.

### 1.5 Security / prompt-injection posture (CC `yZq` + `# Doing tasks` OWASP bullet) — **partial** [MED]
- **CC:** Security clause `yZq` (authorized testing / refuse destructive) in `P5z`; OWASP bullet in `Z5z` ("Be careful not to introduce command injection, XSS, SQL injection… if you wrote insecure code, immediately fix it"); plus the prompt-injection-flagging rule.
- **deepcode:** HAS the prompt-injection rule (`src/prompt.ts:41`) and the system-reminder-not-authoritative rule (`:42`) — both good, well-mirrored. LACKS the OWASP "don't write insecure code" rule and the dual-use security-testing posture clause.

### 1.6 Plan-mode & auto-mode reminder system — **deepcode has 1 of ~39** [LOW for now]
- **CC:** `system-reminders.md` documents a full plan-mode V2 interview workflow (`Nzz`), Phase-4 final-plan ledger variants, exit/re-entry/verify reminders, and an auto-mode set.
- **deepcode:** one static `PLAN_MODE_GUIDANCE` (`src/prompt.ts:11`) injected by the TUI. This is **largely [N/A] / out of scope** — deepcode's plan mode is intentionally simpler. Noted for completeness, not prioritized.

### 1.7 "Don't propose changes to code you haven't read" + "don't brute-force a blocked approach" + "no time estimates" [LOW]
- **CC:** `main-system-prompt.md` §3 has three crisp rules deepcode lacks: don't propose changes to unread code (deepcode has the inverse "must Read before edit" but not "don't *propose* changes to unread code"); if blocked don't retry the same action — find an alternative or ask; avoid giving time estimates.
- **deepcode:** none of these three are present.

### 1.8 Tool-description depth — see §2.

---

## 2. Tool descriptions — CC has / deepcode lacks

deepcode's tool `description` fields are one-liners; CC embeds substantial usage policy. The model never sees that policy in deepcode.

| Tool | CC (see `tool-descriptions.md`) | deepcode (file:line) | Gap |
|------|-------------------------------|----------------------|-----|
| **Bash** | Multi-section: dir verification, quoting rules, the "use Read/Grep/Glob not cat/find/grep" mandate, git-commit & PR workflow embedded, background-task guidance, sandbox notes. | `src/tools/bash.ts:30-31` — one sentence (persistent cwd, 120s timeout, truncation, "用 Glob/Grep 不用 find/grep"). | **[HIGH]** deepcode omits the entire embedded **git commit / PR-creation workflow** (CC `feature-prompts.md` §4) — a major behavioral asset. Also omits quoting/path-with-spaces guidance. |
| **Read** | Notes images/PDF/notebook handling, multimodal, line-truncation, "don't re-read files already in context," malicious-code-no-augment posture. | `src/tools/read.ts:19-20` — one sentence. | **[MED]** Multimodal notes are **[N/A]** (DeepSeek no vision). But "don't re-read" and the malicious-code reminder are missing. |
| **Edit** | Uniqueness requirement, replace_all, "read first," whitespace-match guidance. | `src/tools/edit.ts:32-33` — actually **good**, covers uniqueness + replace_all + read-first. | Small gap only. |
| **Grep / Glob** | CC's are long with ripgrep-syntax notes, multiline mode, output modes, path-filter examples. | `src/tools/grep.ts:57`, `glob.ts:15` — one line each. | **[LOW]** deepcode's are functional; CC's give the model more search leverage (regex/multiline modes). |
| **Task/Agent** | Long: when to use subagents, "don't duplicate work," parallelization, stateless-prompt requirement, autonomy. | `src/tools/agentTypes.ts:92-95` (`buildAgentDescription`) — covers stateless-prompt + roster, **good**, but omits "don't duplicate subagent work" and parallelization. | **[MED]** |
| **WebSearch** | Domain filtering, sources-citation reminder. | `src/tools/webSearchTool.ts:47-50` — **strong**, has the forced "Sources:" citation + domain filter + current-year hint. Arguably better than CC's. | Near-parity. |
| **TodoWrite / Task list** | CC's TodoWrite description is very long with when-to-use, examples, status discipline. | `src/tools/taskListTools.ts:21,63` — terse but covers "3+ step → plan first" and single-in_progress discipline. | **[LOW]** |
| **ExitPlanMode / AskUserQuestion / NotebookEdit / Write** | — | `exitPlanMode.ts:21`, `askUserQuestion.ts:42`, `notebookEdit.ts:19`, `write.ts:15` — all present and reasonable. | Near-parity. |

**Net:** the single highest-value tool-description gap is **the git-commit / PR-body workflow** that CC bakes into the Bash tool description (`feature-prompts.md` §4). deepcode has no commit-message or PR-body generation guidance anywhere.

---

## 3. Feature / utility prompts — CC has / deepcode lacks

| CC feature prompt | Source | deepcode status |
|-------------------|--------|-----------------|
| **Conversation compaction / summarization** (9-section structured summary `Yx9`/`zx9`) | `feature-prompts.md` §1 | deepcode's `SUMMARY_PROMPT` (`src/compact.ts:6-12`) is structured but **only 5 sections** (任务背景 / 已做决策 / 改过的文件 / 未完成事项 / 下一步). It **omits CC's "Key Technical Concepts," "Errors and fixes," and "Problem Solving"** sections. **[MED]** quality gap — losing tech-stack context and prior-error context across compaction. |
| **Git commit message generation** | `feature-prompts.md` §4 | **Absent.** No commit-message prompt in deepcode. **[HIGH]** if commit help is desired. |
| **PR body generation** (`## Summary` / `## Test plan`) | `feature-prompts.md` §4 | **Absent.** [MED] |
| **Conversation title + branch generation** (`yVY`) | `feature-prompts.md` §2 | Likely **[N/A]** unless deepcode generates session titles. |
| **Bash command-prefix classifier** (`P9z` `<policy_spec>`) | `feature-prompts.md` §5 | deepcode does prefix/permission matching in `src/permissions.ts` / `deny.ts` — **check if it uses an LLM classifier or pure string logic.** CC uses an LLM `<policy_spec>` call. deepcode appears rule-based (no LLM call) → arguably simpler/cheaper, **[N/A] by design** but worth a note. |
| **New-topic detection** (`d34`) | `feature-prompts.md` §3,7 | Absent. [LOW] |
| **Memory builders** (`bv9` extract/access, `<types>` taxonomy) | `feature-prompts.md` §9 | deepcode has a memory subsystem (`src/memdir/`). Compare taxonomies separately — out of scope here. |

---

## 4. deepcode has / CC lacks (and what's legitimately N/A)

### 4.1 deepcode-original strengths to KEEP
- **Verification-before-done rule** (`src/prompt.ts:44`): "「完成」是用户能用上结果，不是写完文件：报告完成前先实际验证产物能用——跑测试、执行脚本、打开产物看输出。极简是不镀金，不是不冲过终点线". This is **sharper than anything in CC** — CC has simplicity rules and an "if a test fails, find alternatives" rule, but no explicit "verify the artifact actually runs before reporting done." **Strong differentiator; keep verbatim.**
- **Honest-reporting rule** (`src/prompt.ts:48`): "测试失败就贴出输出说失败，没跑验证就说没跑、不要暗示成功" — CC has nothing this explicit about not faking success. Keep.
- **Forced WebSearch source citation** (`src/tools/webSearchTool.ts:48-50`) — at parity or better than CC.

### 4.2 Legitimately N/A for deepcode (do NOT port)
- **Multimodal / vision / image / PDF handling** in Read (CC) — DeepSeek has no vision. **[N/A]**
- **Language block** (CC `M5z` "Always respond in ${lang}") — deepcode is natively Chinese; the whole prompt is Chinese, so a language directive is redundant. **[N/A]**
- **Model-family env note** ("most recent Claude model is 4.5/4.6…", `main-system-prompt.md` §9) — deepcode is DeepSeek. **[N/A]**
- **Fast-mode info / Anthropic-specific harness notes** — **[N/A]**.
- **AskUserQuestion `preview` HTML fragment** (`tool-descriptions.md` §13) — this is a *single-output TUI* feature for rendering inline HTML mockups in a question card; deepcode's TUI doesn't render HTML previews. **[N/A]** (and note: this is NOT an output-form preference — see §5).
- **Background-shell BashOutput/KillBash → Task subsystem migration** — deepcode already uses its own `TaskOutput`/`taskTools.ts`; architecture differs, not a prompt gap.

---

## 5. HTML / output-form bias check — **DEFINITIVE VERDICT**

**deepcode's bias** lives at `src/prompt.ts:47` (inside `CODING_RULES`, the Bash-no-tty bullet):

> Bash 工具没有 tty：curses/全屏/交互式程序在这里无法运行… 因此做「能玩/能用」的东西时，优先选你能实际跑起来、或用 open(mac)/xdg-open(linux) 打开来验证的形态——**自包含单文件 HTML 优于终端 curses**；做完主动打开或运行交付给用户…

### Does CC's prompt contain ANY analogous output-form preference? **NO.**

Exhaustive search of the v2.1.76 bundle for output-form preferences
(single-file HTML, self-contained HTML, artifact bias, "prefer X form over Y",
curses/tty/fullscreen guidance, "open to verify as deliverable"):

1. **`self-contained HTML`** appears **exactly once** in the entire 12 MB bundle, and it is in the **AskUserQuestion `preview` field** (`tool-descriptions.md` §13, `jY4.html` variant):
   > "Preview content must be a self-contained HTML fragment (no `<html>`/`<body>` wrapper, no `<script>`/`<style>`…) … Use the optional `preview` field on options when presenting concrete artifacts that users need to visually compare: HTML mockups of UI layouts or components…"
   This is a **UI affordance for comparing options inside a question card** — it does NOT instruct the model to *deliver work product* as single-file HTML, and it is not a preference over terminal programs. It's the opposite scope.
2. **`HTML`** otherwise appears only in **WebFetch** ("converts HTML to markdown" — input processing, `tool-descriptions.md` §8) and CSS-selector token tables in vendored libs — never as an output preference.
3. **`open` / `xdg-open`** appear only as CC's *internal* utilities (opening a browser for OAuth, year-in-review, IDE) — never in any LLM-facing prompt as "deliver work as an openable file."
4. **No curses / tty / fullscreen / "interactive program won't run here"** guidance exists in any system prompt. CC's Bash description does note sandbox/background behavior, but **never** expresses a preference for one *output artifact form* over another.
5. CC's only file-form guidance is the **opposite** of a bias toward creating artifacts: *"Do not create files unless they're absolutely necessary… prefer editing an existing file to creating a new one"* (`main-system-prompt.md` §3, `Z5z`).

### Conclusion

**CC has NO HTML / single-file-artifact / output-form preference in any of its LLM-facing prompts.** deepcode's "自包含单文件 HTML 优于终端 curses" bias at `src/prompt.ts:47` is **deepcode-original and not mirrored by CC.**

**Recommendation (validated):** The *factual* half of that bullet is correct and worth keeping — Bash here truly has no tty, so curses/fullscreen/interactive programs genuinely cannot run or be verified by the agent. But the *prescriptive* "自包含单文件 HTML 优于终端 curses" clause is an opinionated output-form steer that CC deliberately avoids, and it can mislead the model into producing HTML when the user wanted a real script/CLI. **Narrow it:** keep "Bash has no tty, so prefer a form you can actually run/verify (e.g. open it with open/xdg-open); for genuinely terminal-only programs, hand it to the user to run," and **drop the blanket "HTML 优于 curses" value judgment** (or scope it to "when the deliverable is a visual/playable thing *and* no runnable form is specified"). This removes a bias CC explicitly doesn't carry while preserving the true tty constraint.

---

## 6. Prioritized optimization suggestions

Each tied to a concrete CC behavior + a deepcode target.

### HIGH
1. **Add an "执行有破坏性的动作要谨慎" section** mirroring CC `G5z` (`main-system-prompt.md` §4). Target: new block in `src/prompt.ts` `CODING_RULES` (or a sibling const). Include: reversibility/blast-radius heuristic, confirm-before destructive/hard-to-reverse/shared-state actions, an example list (rm -rf, force-push, git reset --hard, push, send message), and "授权只在请求的范围内有效，一次批准 ≠ 永久批准." This is deepcode's single biggest missing policy.
2. **Bake the git commit-message + PR-body workflow** into the Bash tool description or `CODING_RULES`, mirroring CC `feature-prompts.md` §4 (the `# Committing changes with git` / `# Creating pull requests` block, `## Summary`/`## Test plan` PR format, and `Co-Authored-By` trailer convention). Target: `src/tools/bash.ts:30` description, or a dedicated commit guidance const. deepcode currently has zero commit/PR guidance.
3. **Narrow the HTML output-form bias** at `src/prompt.ts:47` per §5 — keep the tty fact, drop the "HTML 优于 curses" value judgment.

### MED
4. **Expand dedicated-tool routing** (CC `f5z`, `main-system-prompt.md` §5) in `src/prompt.ts:45`: add "编辑用 Edit 不用 sed/awk；写文件用 Write 不用 heredoc/echo；Bash 只留给真正需要 shell 的系统操作." Currently only the find/grep/cat half is covered.
5. **Add a conciseness + tone block** (CC `v5z`/`N5z`, §6–7): "先给答案/动作再给理由；一句话能说清就别用三句；不用 emoji 除非用户要；工具调用前的文字不要以冒号结尾." Target: append to `CODING_RULES` or the opening identity line `src/prompt.ts:72`.
6. **Add 3 sections to the compaction prompt** (CC `feature-prompts.md` §1, 9 sections). Target: `src/compact.ts:6-12` (`SUMMARY_PROMPT`, currently 5 sections). Add **Key Technical Concepts**, **Errors and fixes**, and **Problem Solving** to match CC and reduce post-compaction amnesia about the tech stack and prior failed attempts.
7. **Add the OWASP "don't write insecure code" rule** (CC `Z5z`) to `CODING_RULES` (`src/prompt.ts:37-48`).
8. **Add "don't duplicate subagent work" + parallelization** to the Task description (`src/tools/agentTypes.ts:92`), mirroring CC `T5z`.

### LOW
9. **Tighten the simplicity sub-list** (CC `Z5z` list `A`): add the specific "别给没改动的代码加注释/类型；只在系统边界做校验；确定无用就直接删不要留兼容垫片" granularity to `src/prompt.ts:44`.
10. **Add the three crisp rules** from CC §3: "别对没读过的代码提改动建议"; "被卡住别反复重试同一动作——换路子或问用户"; "别给时间估算". Target: `CODING_RULES`.
11. **Enrich Grep/Glob descriptions** (`src/tools/grep.ts:57`, `glob.ts:15`) with regex/multiline/output-mode hints per CC, to give the model more search leverage.

### Do NOT do (N/A — see §4.2)
- Don't port multimodal/vision Read notes, the Language block, Claude model-family env note, fast-mode info, or the AskUserQuestion HTML-preview affordance.

---

## 7. Coverage note

This analysis compares **prompt text**, not enforcement. deepcode enforces several
CC-prompt behaviors at the *runtime* layer instead (permissions in `src/permissions.ts`/
`src/deny.ts`, file-state read-before-edit in `src/tools/edit.ts:15-29`,
SSRF in `src/ssrfGuard.ts`). Those are real and sometimes stronger than CC's prompt-only
guidance — but the *model itself* is never told the heuristic, which matters when the
model is choosing whether to attempt a risky action in the first place. The §6 HIGH
items (esp. #1, destructive-action policy) close that model-awareness gap.
