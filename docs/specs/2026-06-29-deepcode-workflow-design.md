# Workflow 编排 DSL — 设计 spec（deepcode 1:1 CC v2.1.193）

**日期**：2026-06-29
**状态**：设计定稿（brainstorm 五段逐段通过 + 全程实读 CC v2.1.193 bundle 校准）→ 待 writing-plans
**阶段**：阶段 B 大件起点（裁决见 `2026-06-26-deepcode-cc-v2193-gap-and-plan.md` 四点五段；实读后改判 Workflow 先于 Auto mode）
**方法**：每段设计先实读 CC v2.1.193 原生二进制（`scratchpad/cc-latest/package/claude`，`grep -a` 可搜）确证真实实现/字符串，再落地 deepcode，禁臆造。

---

## 0. 范围与根本取舍（用户拍板）

- **v1 范围 = 全量 1:1 一次做到位**：vm 沙箱 + 7 原语 + async 桥接 + structured output + **resume journal** + **/workflows UI** + ultracode 触发。不做 MVP 切分。
- **VM 沙箱 = Node 内置 `vm`**（1:1 CC，非 isolated-vm）。脚本作者=可信模型（主循环本就有全工具权限），故 vm 不是防恶意模型的安全边界，作用是 ①确定性（保 resume）②结构化 API ③I/O 不绕过 agent 计账。接受「可逃逸」。
- **Backend 抽象层 = 加薄接缝**（1:1 CC）：`agent()` 背后走 `WorkflowBackend` 接口，v1 单实现 `InProcessBackend` 包 `runSubagent`；`isolation:'remote'` 报 not available；7.4 FleetView 的插点。
- **触发关键字 = 保留 `ultracode`**（1:1 CC，功能型魔法词，不本地化）。

---

## 1. 架构与模块划分

新增模块全在 `src/workflow/`（单一职责，well-bounded）：

| 模块 | 职责 | CC 真实接缝对应 |
|---|---|---|
| `parse.ts` | 拆 `export const meta`（AST 校验**不求值**）+ 拆 scriptBody；确定性静态扫描（正则拒 `Date.now/Math.random/new Date`）；编译 `vm.Script` | CC「compile failed / syntax error / must be deterministic / must be plain JavaScript」错误族 |
| `sandbox.ts` | `createContext({__proto__:null},{codeGeneration:{strings:false,wasm:false}})`；注入 7 原语（VM 域 async 蹦床）+ `args`(VM 内 JSON.parse) + `console`/`setTimeout`/`clearTimeout`；async 桥接（host↔VM settle + sanitize 边界） | CC vm context setup + `bindVMAwait/bindVMInvoke` |
| `runtime.ts` | 7 原语语义真身：`agent/parallel/pipeline/phase/log/budget/workflow`。`agent()`→`backend.runAgent`；`parallel/pipeline`→loop 调度内核 + 上限 | CC 原语 prompt `HCo` + harness `Hol` wire 的原语 |
| `backend.ts` | `WorkflowBackend` 接口 + 单实现 `InProcessBackend`（一次性 `runAgent(spec)→结果`，包 `runSubagent`，不要 CC 流式 sendMessage/isActive 生命周期）；`isolation:'remote'`→拒 | CC `BackendRegistry`/`InProcessBackend`（Tmux/Pane/ITerm 终端后端属 swarm/FleetView，**不在本范围**）|
| `journal.ts` | append-only JSONL `LocalFileJournal` + 8 种 `workflow_*` 记录；resume 缓存键（index+(prompt,opts)）+ 最长未变前缀重放 | CC `LocalFileJournal` |
| `orchestrator.ts` | 顶层 harness：runId 生成、journal 接线、phase/进度事件、abort 传播、budget | CC `Hol({hooks,budget,abortSignal,timers,resolveWorkflow,getAllWorkflows,intakeClone})` |
| `tools/workflow.ts` | `Workflow` 工具：schema(`script/name/scriptPath/args/resumeFromRunId`)，返回 `async_launched`+taskId+runId，后台跑 | CC 工具 `Dv` |

**复用现成**（不重建）：
- `subagentRunner.ts` `runSubagent(opts)` 带 `outputSchema`/StructuredOutput → `agent({schema})` 直接落地
- `tasks.ts` `BackgroundTask`/`enqueueNotification`/`drainNotifications` + `loop.injectTaskNotifications` → `async_launched` + 完成通知 + `/workflows` 数据源（需给 `BackgroundTask.type` 加 `'local_workflow'`）
- `worktree.ts` `createWorktree/removeWorktree/worktreeChanges` + Agent `isolation:"worktree"` → `agent({isolation:'worktree'})`
- `loop.ts` `CONCURRENCY` 只读并发批 → parallel/pipeline 调度内核（加 `min(16,cpu-2)`/1000/4096 上限）
- `settingsLayers.ts` `parsePresent` → workflow 触发/UI 配置注册（`skipWorkflowUsageWarning` 等，非 DANGEROUS）

---

## 2. DSL 表面与语义（1:1 CC，verbatim 自专家报告 + bundle 复核）

**`meta` 块**（纯字面量，无变量/函数/spread/模板插值）：`{name, description, phases:[{title,detail}]}`；工具入参的 `description`/`title` 被忽略（以 meta 为准）。

**7 原语**：

| 原语 | 语义 |
|---|---|
| `agent(prompt, opts?)` | 派 subagent。`opts={label,phase,schema,model,effort,isolation,agentType}`。无 schema→返回文本字符串；有 schema(JSON Schema)→强制 StructuredOutput 返校验对象；用户跳过/终态错误→`null`。`isolation:'worktree'`→worktree 跑（未改动自动删）；`isolation:'remote'`→报 not available |
| `parallel(thunks)` | **barrier**：await 全部（必须传 `()=>agent(...)` thunk，非 promise）；某 thunk throw→该位 `null`，调用本身不 reject |
| `pipeline(items, ...stages)` | **无 barrier 流水线**（多 stage 默认用它）；stage 签名 `(prev, orig, idx)`；某 stage throw→该 item 降 `null` 跳剩余 stage |
| `phase(title)` | 开进度组，后续 agent() 归该组 |
| `log(msg)` | narrator 进度行 |
| `budget` | `{total, spent(), remaining()}`，跨主循环+所有 workflow 共享 token 池，HARD ceiling（达 total→后续 agent() throw）；`total` null=无目标，`remaining()`=Infinity |
| `workflow(nameOrRef, args?)` | 内联跑另一 workflow，共享并发 cap/agent 计数/abort/budget；**仅一层嵌套**（child 内调 throw）|
| `args` | Workflow 入参 verbatim（JSON 值，非 stringified）|

**确定性约束**：禁 `Date.now/Math.random/new Date`（静态正则拒 + 不注入）、`eval/new Function`（`codeGeneration:{strings:false}`）、`wasm`、`import()`（throw）、fs/Node API；纯 JS（非 TS）。提供 `console/setTimeout/clearTimeout` + 标准内置（JSON/Math/Array…）。

**两处 deepcode 映射决策**（CC 无直接对应，实读后定）：

- **`opts.effort`（采纳「补上」而非 noop/lossy）**：deepcode **已有** 3 级 effort 轴（`api.ts:122/132` `effortLevel?:'low'|'medium'|'high'` → `api.ts:136` thinking on 时 `{reasoning_effort: effortLevel??'medium', thinking:{type:'enabled'}}`；`loop.ts:23/167`、`session.ts:11/110`、TUI 全链路已接）。唯一缺口：`runSubagent` opts 没暴露 `effortLevel`（且 `subagentRunner.ts:88-92` 硬编码 `thinking:false`）。
  - **补法（外科手术，不动现有调用者）**：`RunSubagentOpts` 加 `thinking?` + `effortLevel?`（**默认保持 `thinking:false`**，Agent/Explore/Plan/记忆行为不变）→ 传进内层 `runLoop` deps（替换硬编码 `thinking:false`）。
  - **Workflow `agent()` 映射**：`opts.effort` `low/medium/high`→直传；CC 的 `xhigh/max`→**clamp 到 deepcode 上限 `high`**（5→3 级，文档标注）；省略→继承 session `effortLevel`，设 effort 时 thinking on。骑 `api.ts:136` 现成 `reasoning_effort` 通道，零 provider 改动。effort **真生效**（`'low'` 真省 token，`'max'`→high 真加推理）。
- **`opts.model`**：省略→继承 session 当前活跃模型（**1:1 CC**：journal 记 `model: re?.model ?? N.options.mainLoopModel`，非 sub 档 resolveSubModel）；`opts.model` 字符串→走 deepcode 现有别名解析（resolveAgentModelAlias/resolveSubModel）。

**硬上限**（1:1 CC verbatim，§5 钉死）：并发 `min(16,cpu-2)`／单 workflow ≤1000 agent／单次 parallel/pipeline ≤4096 item／同步切片 30s（`AGn=30000`）。

---

## 3. 执行流 + async 桥接 + resume/journal（逐字锚 CC 真实实现）

**执行流**（`orchestrator.ts` 驱动）：
```
parse.ts:   拆 meta(AST 不求值) → 静态扫描禁 Date.now/random → 编译 vm.Script
            脚本体包成 (async()=>{'use strict'; <body>})()   ← top-level await 生效
            new vm.Script(body,{filename:"workflow.js", importModuleDynamically:()=>throw})
sandbox.ts: createContext({__proto__:null},{codeGeneration:{strings:false,wasm:false}})
            注入「VM 域 async 蹦床」: runInContext("(hostFn=>async(...a)=>hostFn(...a))")(host原语)
            args:  runInContext(`JSON.parse(${JSON.stringify(args)})`)  → context-native
            console/setTimeout/clearTimeout
runtime:    蹦床背后 host 原语真身（agent→backend.runAgent, parallel/pipeline→调度器）
host await: runInContext("(async v=>({__proto__:null, v:await v}))")(脚本promise) + drainMicrotask
边界值:     sanitizeVMValue / structuredClone
sync slice: vmScript.runInContext(ctx, {timeout: 30000})
```

**async 桥接核心（最硬，逐字照搬 CC，禁臆造）**：原语是 host 用 `runInContext` 在 **VM 域内**造的 async 蹦床（`(hostFn=>async(...a)=>hostFn(...a))`），脚本 `await agent(...)` 时 await 的是 **VM 域 promise**，绕开跨域 promise interop + `codeGeneration:{strings:false}`（蹦床由 host 造，非沙箱脚本造）。host 侧用 in-VM await 包装器 `(async v=>({v:await v}))` + 抽干微任务取脚本结果。

**journal / resume**（`journal.ts`）：
- append-only JSONL，每原语一条记录。`workflow_agent` 记录形如：`{type:"workflow_agent", index, label, phaseIndex, phaseTitle, agentId, model: opts.model ?? sessionModel, status, prompt, result}`（bundle verbatim 结构）。另：`workflow_log/phase/tool/permission_prompt/usage_consent/remote_agent/complete`（1:1 CC 8 种）。
- **缓存键 = `index`（调用位置）+ `(prompt,opts)` 相等**。
- **resume = 最长未变前缀**：按 index 走，匹配则返缓存结果，**首个 (prompt,opts) 不符 → 从该点起 live 重跑**，其后全 live。Same script + same args → 100% 命中。**仅同 session**。
- **关键正确性**：缓存键是**位置 index**，故并发完成顺序不影响 resume（绕开并发非确定性；确定性约束保证 index 序稳定）。
- runId = `wf_<12hex>`（1:1 CC `wf_${randomUUID().slice(0,12)}`，正则 `/^wf_[a-z0-9-]{6,}$/`）；resume 前须先 `TaskStop` 旧 run。
- journal 落 `.deepcode/workflows/<runId>/journal.jsonl`。

**deepcode 接线**：`tasks.ts` `BackgroundTask.type` 加 `'local_workflow'`；Workflow 工具返回 `{status:"async_launched", taskId, runId, scriptPath}`；orchestrator 每次 `agent()`：先按 index+(prompt,opts) 查 resume 缓存→命中返缓存/未命中走 backend + append 记录。

---

## 4. 触发 + UI + 上限/错误处理

**触发**（3 路，1:1 CC）：
- `ultracode` 关键字出现在 prompt → 该 turn 转 workflow 编排（settings `workflowKeywordTriggerEnabled`，可撤销提示）
- `/effort ultracode` → session 级「`high` + dynamic workflow orchestration」（CC 是 xhigh，deepcode clamp→high，承 §2）
- 直接让模型调 Workflow 工具

**消费门**：首次用 workflow 弹一次性成本警告（多 agent/多 token），`skipWorkflowUsageWarning` 后不再弹。**与 auto mode 解耦**（deepcode 无 7.5）——独立一次性确认，不依赖权限模式。

**/workflows UI**（1:1 CC，deepcode 现有 Ink 组件渲染，**双组件 App.tsx + FullscreenApp.tsx**）：phase 分组进度树，每行 `agentType·model·N tok·N tools·时长·⟳/✓/✗`，底部 `done/total · 进度条`；完成态 `Completed in Ns · N agents · N tokens`；后台运行提示「`/workflows` to monitor and save」。数据源 = journal + `tasks.ts` BackgroundTask。

**上限 + 错误族**（1:1 CC verbatim，测试/工具契约按此钉死，§5）。

---

## 5. 测试策略 + 冒烟验收

**纯逻辑单测**（免冒烟）：
- `parse.ts`：meta 字面量提取 / 确定性扫描拒 `Date.now` / 非纯 JS 拒 / async IIFE 包装
- `journal.ts`：append + resume 缓存键（index+(prompt,opts)）+ 最长未变前缀（改第 N 步→前 N-1 命中、N 起 live）
- `runtime`：`parallel` barrier + throw→null / `pipeline` 无 barrier + stage throw→item drop / `budget` 达 total→throw / 上限 4096、1000
- `sandbox`：`codeGeneration:strings:false` 拒 eval / args JSON.parse 注入 / 蹦床 await 解析
- `backend`：`isolation:'remote'`→报 not available

**集成测**（async 桥接是命门）：真脚本 `await agent()` 解析、parallel/pipeline 完成序、resume 端到端缓存命中。

**真机冒烟**（TUI 双组件铁律）：
1. `ultracode` 关键字触发 → 模型写脚本 → Workflow 工具跑端到端，结构化结果
2. `/workflows` 进度树渲染（phase 分组 + `Completed in Ns·N agents·N tokens`）**双组件都验**
3. resume：改一个 stage 重跑 → journal 缓存命中、仅改动+下游 live
4. 确定性拒：`Date.now()` 脚本→解析期拒
5. `agent({isolation:'worktree'})` 真起 worktree、隔离改动

**工具注册三处铁律**：`tools/index.ts` allTools + `tools.registry.test` 计数 + `agent.test` 计数 + **`GLOBAL_SUBAGENT_DENY += 'Workflow'`**（子代理禁用→保证仅一层嵌套，1:1 CC `disallowedTools:[Dv]`）。

### CC verbatim 校验串（测试断言 + 工具契约 1:1 钉死，模型读的协议串保留英文原文）

| 校验 | CC verbatim |
|---|---|
| 确定性 | `Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable (breaks resume). Stamp results after the workflow returns, or pass timestamps via args` |
| 纯 JS | `Workflow scripts must be plain JavaScript — TypeScript syntax (type annotations like ': string[]', interfaces, generics) ...` |
| parallel | `parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)` |
| 并发上限 | `Concurrent agent() calls are capped at min(16, cpu cores - 2) per workflow — excess calls queue and run as slots free up` |
| 4096 | `A single parallel()/pipeline() call accepts at most 4096 items; passing more is an explicit error, not a silent truncation.` |
| 1000 | `Total agent count across a workflow's lifetime is capped at 1000 — a runaway-loop backstop set far above any real workflow.` |
| resume | `Stop the prior run first (…) before resuming.` |
| StructuredOutput | `StructuredOutput retry cap exceeded` / `subagent completed without calling StructuredOutput (after in-conversation nudge)` |
| 嵌套 | `Nesting is one level only: workflow() inside a child throws.` |
| remote | `isolation:'remote'}) is not available in this build` |

---

## 6. 流程

每模块走 SDD（fresh subagent + sonnet 双审，架构件 Task[sandbox/async 桥接] + 全分支 opus 终审）+ 真机冒烟（碰 TUI 双组件）。转 writing-plans 拆任务（建议按依赖序：parse → sandbox+async 桥接[最硬，独立架构 Task] → backend → runtime → journal/resume → orchestrator → tools/workflow → /workflows UI → 触发接线 → effort 接线[runSubagent 补 thinking/effortLevel]）。

## 7. 证据存档
- CC bundle：`scratchpad/cc-latest/package/claude`（v2.1.193，222M，`grep -a` 可搜）。
- 实读确证：async 蹦床 `runInContext("(hostFn=>async(...a)=>hostFn(...a))")`、journal `workflow_agent" index/model:mainLoopModel`、确定性双层（静态正则 + 不注入）、§5 全 verbatim 校验串。
- deepcode 现状勘察：effort 轴已存在（api.ts:122/136、loop.ts:23、session.ts:11）、runSubagent 硬编码 thinking:false（subagentRunner.ts:88-92）、tasks.ts async_launched 底座、worktree.ts、settingsLayers parsePresent。
