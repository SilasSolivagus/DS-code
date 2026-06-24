# Claude Code Reference Prompts — Index

Extracted from **Claude Code v2.1.76** (build 2026-03-14), bundle
`/opt/homebrew/lib/node_modules/@anthropic-ai/.claude-code-2DTsDk1V/cli.js`
(12 MB minified) cross-checked against `.../sdk-tools.d.ts`. All prompt text is
reproduced verbatim and de-minified (literal `\n` → real newlines). Interpolated
`${...}` identifiers are tool/agent name variables or runtime values, noted inline.

This folder is the **CC side** of a prompt parity study. The deepcode-vs-CC
comparison lives one level up in `../GAP-ANALYSIS.md`.

## Files

| File | What's in it | Primary bundle anchors |
|------|--------------|------------------------|
| `main-system-prompt.md` | The main interactive agent system prompt, assembled at runtime by `R0()`. Identity (`P5z`), `# System` (`W5z`), `# Doing tasks` (`Z5z`), `# Executing actions with care` (`G5z`), `# Using your tools` (`f5z`/`T5z`), `# Output efficiency` (`v5z`), `# Tone and style` (`N5z`), dynamic blocks (memory/env/language/output-style/MCP/scratchpad), env block (`k5z`/`RZq`), plus the `CLAUDE_CODE_SIMPLE` fallback and the `yZq` security clause. | `R0`, `P5z`, `W5z`, `Z5z`, `G5z`, `f5z`, `N5z`, `k5z`, offset ~10303366 |
| `subagents.md` | Built-in subagent system prompts (Explore, Plan, general-purpose, security/output-style/team variants) and the `Task` tool's agent-roster description (`formatAgentLine`). | subagent prompt consts, `T5z`, agent registry |
| `tool-descriptions.md` | Verbatim LLM-facing `description` of every built-in tool: Bash (`Q7`), Read (`s7`), Edit (`R4`), Write (`_K`), Glob (`qz`), Grep (`N9`), Task/Agent (`I46`/`r4`), WebFetch (`sO`), WebSearch (`jv`), TodoWrite (`MB`), NotebookEdit (`bJ`), ExitPlanMode (`Z1q`), AskUserQuestion (`Fw`, incl. `preview` HTML/markdown addenda), TaskOutput (`$C`), TaskStop (`OC`, alias KillShell), Skill (`dP1`), TaskCreate/Get/List/Update, plus a "schema-only / partial" section (MCP resource tools, SendMessage, Config, etc.). **MultiEdit / BashOutput / KillBash / NotebookRead / SlashCommand do NOT exist as standalone tools in this build** — documented as aliases/UI-labels in §21. | per-tool name consts; `sdk-tools.d.ts` `description:` fields |
| `feature-prompts.md` | Utility / helper-LLM prompts: conversation compaction (`Yx9`/`zx9` + analysis variants `Ax9`/`qx9`/`Kx9`), title+branch generation (`yVY`), new-topic detection (`d34`), git commit + PR-body instruction block (incl. `Pv6` attribution trailers), plan/thinking guidance (`Nzz`/`kzz`/`Tzz`), bash command-prefix classifier (`P9z` `<policy_spec>`), and other "You are a…" helpers (security monitor, side-question agent, verification specialist, web-search/WebFetch processors, date parser, agent-architect, status-line agent, `/review`, `/pr-comments`, `/security-review`, memory builders `Cv9`/`Iv9`/`bv9`). | `Yx9`, `yVY`, `d34`, `P9z`, `Nzz`, `Pv6`, `bv9` |
| `output-styles.md` | The 3 built-in output styles: `default` (null), `Explanatory` ("Insights" asides), `Learning` (TODO(human) hands-on collaboration). Includes the shared `JTq` Insights snippet, framing helpers `P5z`/`D5z`, and selection/precedence mechanics (`Tv6`/`IZq`). Both built-ins keep coding instructions (`keepCodingInstructions:true`); no built-in "Concise" exists. | registry `aY6` ~offset 10594000, `D5z`, `JTq` |
| `system-reminders.md` | 39 distinct `<system-reminder>` bodies and injected guidance blocks, dispatched by `Ui8()` (~offset 10573770): the `<system-reminder>` wrapper (`af`/`b5`), context-injection (`eE1`), CLAUDE.md header (`Qv9`), Read malware/empty/EOF/external-edit reminders (`KB9`), todo (`todo_reminder`) and Task-tools (`task_reminder`) reminders, plan-mode V2 interview (`Nzz`) + Phase-4 ledger variants + sub-agent/sparse/exit/re-entry/verify, auto-mode set, agent-teams, skills, memory injection/staleness, diagnostics, output-style, compaction/date-change/ultrathink. | `Ui8`, `af`, `eE1`, `Qv9`, `KB9`, `Nzz` |
| `../GAP-ANALYSIS.md` | The deliverable: deepcode-vs-CC prompt gap analysis with prioritized optimization suggestions and the HTML-bias verdict. | — |

## Categories checked but NOT present as distinct prompts

- **AskUserQuestion option-generation helper** — not a separate LLM call; the main
  agent produces options inline (AskUserQuestion is a tool schema only).
- **Quota / rate-limit helper prompt** — only UI string-formatting code, no helper LLM call.
- **Dedicated "extract facts" memory prompt** — none distinct; background extraction
  reuses the `bv9` extract-mode memory builder.
- **"Concise" built-in output style** — absent; only default/Explanatory/Learning ship.
- **MultiEdit / BashOutput / KillBash / NotebookRead / SlashCommand tools** — absent
  as standalone tools (aliases / UI labels / parser only). See `tool-descriptions.md` §21.

## Partial recoveries (large interpolated prompts, captured as opening + structure)

Marked inline in `feature-prompts.md`: the security-monitor prompt (~12 KB),
verification specialist, agent-architect, status-line agent, `/security-review`,
and the memory `<types>` taxonomy are reproduced as openings + structural notes
rather than full text, due to heavy `${...}` interpolation and length.
