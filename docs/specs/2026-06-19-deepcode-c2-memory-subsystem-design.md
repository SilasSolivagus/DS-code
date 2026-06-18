# C2 记忆子系统设计（master roadmap 3.1 / 3.2 / 3.3 / 3.4）

- 日期：2026-06-19
- 状态：设计已批准，待写实现计划
- 范围：记忆索引（3.1）、自动提取（3.2）、SessionMemory（3.3）、autoDream（3.4）
- 原则：**忠实镜像 Claude Code（CC）memory 子系统，适配 deepcode 接缝**
- CC 源码对齐基准：`/Users/silas/Desktop/src`（memdir/、services/extractMemories、services/SessionMemory、services/autoDream、query/stopHooks）

> 本设计经两轮 CC 源码实证（含 opus 专家深读修正 5 处偏差：路径根、静态/动态 either/or、prefetch+poll 召回、UUID 游标、节流默认与 drain 跳节流）。

---

## 0. 决策记录（brainstorm 拍板）

| # | 决策 | 选择 | 备注 |
|---|---|---|---|
| Q1 | memdir 落盘 scope | **per-project，镜像 CC** | `~/.deepcode/projects/<sani>/memory/` |
| Q2 | 加载机制 | 静态索引 + 动态召回 → **修正为开关，默认仅静态索引** | CC 是 `tengu_moth_copse` either/or，非并存 |
| Q3 | 提取触发 | **镜像 CC：每轮末 fire-and-forget** | 游标防重 + 节流 + coalesce + drain |
| Q4 | SessionMemory | **全保真镜像 CC** | summary.md 草稿本，服务 compact |
| Q5 | 默认开关 | **默认开，可关** | 总开关默认 true；recall 默认 false；dream 重门控 |

CC 实证修正（直接采纳，无需再确认）：

1. **路径根：memdir 用 git root，session-memory 用 cwd**（两套根不同）。
2. **静态索引 vs 动态召回是 either/or**（开召回则把索引移出 system prompt）。
3. **召回是非阻塞 prefetch + poll**，注入在工具结果之后，带多层去重。
4. **提取游标用 message UUID**，仅成功前移、失败重扫。
5. **节流默认 1**；drain/尾部提取跳过节流。

---

## 1. 落盘布局与路径

base = `~/.deepcode`（沿用现有 `~/.deepcode/` 约定；远程/env override 本批不做）。

```
~/.deepcode/projects/<sani(gitRoot ?? projectRoot)>/
  memory/
    MEMORY.md              # 索引：- [Title](file.md) — 一行 hook
    <topic>.md             # 每条一文件，带 frontmatter
    .consolidate-lock      # autoDream PID 锁（mtime = 上次合并时刻）
~/.deepcode/projects/<sani(cwd)>/
  <sessionId>/
    session-memory/
      summary.md           # SessionMemory 草稿本（3.3）
```

**关键：memdir 的项目键用 git root（同 repo 多 worktree 共享一个记忆库），session-memory 的项目键用 cwd。** 两者 sanitize 同函数但入参不同。

新 helper（`src/memdir/paths.ts`）：
- `findGitRoot(cwd): string | null` —— 向上找 `.git`（目录或文件，支持 worktree），找不到返回 null。
- `sanitizeProjectKey(s): string` —— `s.replace(/[^a-zA-Z0-9]/g, '-')`；若超 `MAX_KEY_LEN`（取 CC 风格上限，如 200）则 `slice(0, MAX_KEY_LEN) + '-' + hash(s)`（hash 用 node `crypto` 短摘要 base36）。
- `memdirFor(cwd, home): string` —— `join(home, '.deepcode', 'projects', sanitizeProjectKey(findGitRoot(cwd) ?? cwd), 'memory')`。
- `sessionMemoryPathFor(cwd, home, sessionId): string` —— `join(home, '.deepcode', 'projects', sanitizeProjectKey(cwd), sessionId, 'session-memory', 'summary.md')`。

> 注：deepcode 当前无 `getProjectRoot()` 概念，非 git 时 fallback 直接用 cwd（与 CC 的 projectRoot fallback 等效，因 deepcode 无独立 project-root 解析）。

---

## 2. 记忆文件 schema（复用 CC = 复用用户现有格式）

每条记忆一个 `.md` 文件，frontmatter：

```yaml
---
name: <kebab-slug>
description: <一行；决定召回相关度>
type: user | feedback | project | reference
---
<正文；feedback/project 类型跟 **Why:** 与 **How to apply:** 行；用 [[name]] 链接相关记忆>
```

- `type` 四类固定枚举（`memoryTypes.ts` 定义 + 各类语义提示文本，供提取/dream prompt 引用）。
- `MEMORY.md` 是索引，仅一行指针：`- [Title](file.md) — hook`，不重复正文。
- 加载时 `truncateEntrypoint(content)` 按 ≤200 行 / ≤25KB 双上限截断（超限尾部加省略提示）。

`MemoryHeader`（scan 结果）：
```ts
interface MemoryHeader {
  filename: string      // 相对 memdir 的路径
  filePath: string      // 绝对路径
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
}
```

---

## 3. 配置（`Settings.memory`）

`config.ts` 扩展 `Settings` 加可选 `memory?: MemoryConfig`，宽松解析（非法字段独立丢弃，镜像 `parseMcpServers` 风格；空对象 → 全默认）。

```ts
interface MemoryConfig {
  enabled: boolean                 // 默认 true，总开关
  extractEveryTurns: number        // 默认 1
  recall: { enabled: boolean; maxResults: number }      // 默认 { false, 5 }
  sessionMemory: {
    enabled: boolean               // 默认 true
    minInitTokens: number          // 默认 10000
    minUpdateTokens: number        // 默认 5000
    toolCallsBetween: number       // 默认 3
  }
  dream: { enabled: boolean; minHours: number; minSessions: number }  // 默认 { true, 24, 5 }
}
```

`memory` 不进 `DANGEROUS_TOP_KEYS`（无供应链风险：路径固定在 `~/.deepcode`，工具物理隔离）。可在 user/project/local/flag 各层配，走现有分层合并。

---

## 4. 3.1 记忆索引（加载 + 召回）

### 4.1 静态索引（`recall.enabled === false` 时）

- `buildSystemPrompt(cwd, home, skills, budgetChars, memdir?)` 末尾新增 `## 记忆索引` 段，内容由 `loadMemoryPrompt(memdir)` 提供（读 `MEMORY.md` → 截断 → 含「用 Read 拉 topic 文件」指引；空时给一行「记忆为空」提示）。
- 与现有 `findMemoryFiles`（DEEPCODE.md 项目说明）**并存，两段独立**。
- 会话启动构一次（保 KV 缓存静态）。

### 4.2 扫描

`scanMemoryFiles(memdir, signal?): Promise<MemoryHeader[]>`（`src/memdir/memoryScan.ts`）：
1. `readdir(memdir, { recursive: true })`，过滤 `*.md`，排除 `MEMORY.md`。
2. 并发读每文件前 30 行，`parseFrontmatter` 取 `description` / `type`。
3. 按 `mtimeMs` 降序，cap 200（`MAX_MEMORY_FILES`）。

`formatMemoryManifest(headers): string` —— `[type] filename (mtime): description` 清单，供提取/dream 预注入防重。

### 4.3 动态召回（`recall.enabled === true` 时）

- 此时**不注静态索引**（移出 system prompt），改靠召回。
- `findRelevantMemories(client, query, memdir, signal): Promise<RelevantMemory[]>`（`src/memdir/findRelevantMemories.ts`）：
  - DeepSeek 侧调用（独立小请求），`max_tokens ≈ 256`，system = 选择 prompt，输出 JSON `{ selected: string[] }`，≤ `recall.maxResults`。
  - 用 `scanMemoryFiles` 的真实文件名集校验，剔除幻觉文件名。
  - 失败 / abort → `[]`（fail-safe，绝不阻断主对话）。
- **触发与注入（镜像 CC prefetch+poll）**：
  - 每个 user turn 启动一个非阻塞 prefetch（turn 外发起，turn 内主模型 streaming + 工具执行期间后台跑）。
  - tools 跑完后 poll：ready 则取，未 ready 跳过等下一轮。
  - 选中文件全文经 `<system-reminder>` 注入（`ctx.injectUserMessage` 包裹），**不进静态 system prompt**。
  - 去重三层：① `fileState`（本轮模型已 Read 的不再 surface）② 跨轮 seen-set（已 surface 过的不重复）③ 总字节上限。

> deepcode 现有 reminder/注入接缝：`ToolContext.injectUserMessage` + `LoopDeps.drainInjections`（1.2 Skills 已建）。召回注入复用此通道。

---

## 5. 3.2 自动提取

### 5.1 触发与节流

- 接缝：useChat send 路径中，每轮助手回复完成（`runLoop` 对该 user turn 返回 done）后，fire-and-forget 调 `runExtraction(ctx)`。
- 门控：`memory.enabled`（提取无独立子 toggle，跟随总开关）+ 轮次节流 `extractEveryTurns`（默认 1 = 每轮）。
- **drain / 尾部提取跳过节流**（收尾那批不被吞）。

### 5.2 游标与判重

- **游标 = message UUID**：给会话消息补稳定 `uuid`（生成时附；resume 时从 JSONL 读回）。`lastMemoryMessageUuid` 记上次处理位置。
- 仅在提取**成功**后前移游标；失败不动（下次重扫该区间）。
- `hasMemoryWritesSince(messages, lastUuid)`：若主 agent 已在该区间直接写过 memdir 文件，跳过 fork、直接推进游标（主/后台分工去重）。

### 5.3 coalesce

- `inProgress` 标志防重叠；执行中又触发 → 暂存 `pendingContext`，当前跑完自动起 trailing run（仅处理新增消息，跳节流）。
- `inFlightExtractions: Set<Promise>` 追踪未决，供 drain 等待。

### 5.4 forked 受限 agent

- 经 `runSubagent`（`subagentRunner.ts`），`tools = makeMemdirTools(memdir)`：
  - `readTool`（只读，不限路径——用于读现有记忆文件）
  - memdir 绑定的 `Edit` / `Write`：`call` 内 `resolve` 路径并断言落在 memdir 内，否则拒（物理隔离，不靠权限层）。
- `userPrompt`：含 `formatMemoryManifest`（现有清单防重）+ 最近 N 条消息内容 + 四类 schema 说明 + 「禁 grep 源码 / 禁 git 探索」约束 + 「两步保存：写文件 + 更新 MEMORY.md」。
- `maxTurns: 5`（防验证死循环）。
- `skipTranscript`：不写主会话转录。
- 成功后若写了文件，向主会话注一条系统提示「已沉淀记忆：<paths>」。

### 5.5 drain

- `fireSessionEnd('clear' | 'exit')` 与 `dispose()` 中调 `drainPendingExtraction()`：等所有 in-flight + 触发一次尾部提取（跳节流），有界 block（超时上限防卡退出）。

---

## 6. 3.3 SessionMemory

### 6.1 文件与模板

- 路径 `sessionMemoryPathFor(cwd, home, sessionId)` → `summary.md`。
- 结构化模板（镜像 CC，章节）：
  ```
  # Session Title
  # Current State
  # Task specification
  # Files and Functions
  # Errors & Corrections
  # Learnings
  # Worklog
  ```
- 首次触发时若文件不存在，写模板。

### 6.2 触发

- 门控：`memory.enabled && memory.sessionMemory.enabled`。
- post-turn 检查 `shouldExtractSessionMemory(messages)`：
  ```
  trigger = (hasMetTokenThreshold && hasMetToolCallThreshold)
         || (hasMetTokenThreshold && !hasToolCallsInLastTurn)
  ```
  - token 阈值：首次 `minInitTokens`，之后每次间隔 `minUpdateTokens`（用 token 估算，复用 compact 的估算函数）。
  - tool-call 阈值：自上次更新累计 `toolCallsBetween` 次，或最后一轮无 tool_calls（自然断点）。

### 6.3 维护与并入 compact

- forked agent 仅可 `Edit` 该 `summary.md`（`makeFileEditTool(path)` 单文件白名单）。
- 更新 prompt：载入当前内容 + 分析各章节大小（超预算警告哪节太长）+ 指令编辑。
- **并入 compact**：`doCompact` 调 `summarize()` 前，把 `summary.md` 内容前置进压缩输入，使压缩后保留会话状态。

---

## 7. 3.4 autoDream

### 7.1 触发与门控

- 接缝：query-end fire-and-forget（与提取同站点），`executeAutoDream(ctx)`。
- 门控：`memory.enabled && memory.dream.enabled`，再叠三关：
  1. **时间**：`now - lastConsolidatedAt(锁文件 mtime) ≥ minHours`（默认 24h）。
  2. **会话数**：自上次合并以来 touched 的会话数（排除当前）`≥ minSessions`（默认 5）。
  3. **PID 锁 CAS**：`tryAcquireConsolidationLock()`。
- 时间过但会话不过 → 10min 内不再扫（扫描节流）。

### 7.2 锁机制

`src/services/memory/consolidationLock.ts`，锁文件 `<memdir>/.consolidate-lock`：
- 内容 = 当前 PID；mtime = `lastConsolidatedAt`。
- `tryAcquireConsolidationLock()`：读现有 PID + mtime；若 PID 活跃且 mtime < 1h → 拒（已占有）；否则写新 PID 再读验证（CAS）。
- `rollbackConsolidationLock(priorMtime)`：失败时回退（priorMtime=0 → unlink；否则写空 + 回退 mtime）。

### 7.3 执行

- 作 `tasks.ts` 跟踪任务（`registerTask` 复用现有 `local_agent` type），带进度 watcher + 完成 `enqueueNotification`。
- forked 受限 agent（`makeMemdirTools(memdir)`），consolidation prompt 四阶段：Orient（ls + 读 MEMORY.md + skim topic）→ Gather（现存记忆优先）→ Consolidate（合并新信号、相对日期转绝对、删过时）→ Prune（修剪 MEMORY.md ≤200 行/25KB）。
- 单独 AbortController（可被 TaskStop 杀）。
- 成功 → `completeDreamTask` + 若改文件注「Improved N memories」系统提示；失败 → `failDreamTask` + `rollbackConsolidationLock`。

---

## 8. 错误处理与安全

- **fail-safe 第一**：所有 forked 记忆操作（提取/召回/SessionMemory/dream）异常一律吞掉 + 记 debug 日志，**绝不阻断主对话或退出**（drain 有超时上限）。
- **路径隔离**：`makeMemdirTools` 的 Edit/Write 在工具 `call` 内 `path.resolve` 后断言前缀落在 memdir/单文件内，越界（含 `..`、绝对路径逃逸）直接拒；不依赖权限层。
- **权限**：forked agent 走 `subagentPermissionDecision`（yolo：安全自动放行/危险拒绝），但写工具物理只能落 memdir。
- **resume**：消息 uuid 跨 resume 从 JSONL 读回；游标重建；锁文件 mtime 持久。
- **并发**：autoDream PID 锁防多进程同时合并；提取 `inProgress` 防同进程重叠。

---

## 9. 测试策略

- **纯函数单测**：`sanitizeProjectKey` / `findGitRoot`（mock fs）/ `parseFrontmatter` / `scanMemoryFiles` 排序与 cap / `formatMemoryManifest` / `truncateEntrypoint` 双上限 / `shouldExtractSessionMemory` 谓词 / 节流谓词 / 锁 CAS（mock fs + now）/ `hasMemoryWritesSince`。
- **FS 隔离**：所有真 I/O 测试用临时目录 + `try/finally` 还原，**绝不读写真实 `~/.deepcode`**（3.9/4.5 教训：改写路径的测试务必同步 mock 新写函数）。
- **forked 流程**：mock `client` / `runSubagent`，验证 prompt 组装、游标推进、coalesce、drain、注入通道。
- **门控**：`enabled=false` 时全链路零副作用（不 fork、不调模型、不写盘）。

---

## 10. 实现仪式与分期

- **能力件全仪式**：本 spec → `writing-plans` 出实现计划 → `subagent-driven-development` 每任务 implementer + 规格审 + 质量审双门 → **opus 全分支终审**。
- **冒烟**：多为非 TUI（memdir 逻辑 + useChat send/compact 接线），按既定免冒烟；召回注入与 dream 通知接线视情况轻冒烟。
- **分期（计划内 task 分组，不拆批）**：
  1. **地基**：paths/types/schema/config 解析 + scan/load + 静态索引接入 `buildSystemPrompt`（3.1 核心，先定 schema）。
  2. **提取**（3.2）：游标/coalesce/drain + `makeMemdirTools` + forked 流程 + useChat 接线。
  3. **召回**（3.1 动态）：findRelevantMemories + prefetch/poll + reminder 注入 + 去重。
  4. **SessionMemory**（3.3）：模板 + 触发 + 编辑 + 并入 compact。
  5. **autoDream**（3.4）：锁 + 门控 + tasks 后台 + consolidation prompt。

---

## 11. 非目标（YAGNI / 本批不做）

- 远程/env memory dir override（`CLAUDE_CODE_REMOTE_MEMORY_DIR` 等价物）。
- 团队共享记忆（CC TEAMMEM / team/ 目录）。
- KAIROS 助手模式日志（logs/YYYY/MM）。
- subagent 级 memory 隔离（@-mention agent 专属 memdir）。
- settings 可配 SessionMemory 阈值之外的更细粒度 GB-flag 等价物（用固定 config 字段即可）。
