# deepcode 安全威胁模型（2026-06-18）

本文档记录 deepcode 安全加固 B 批（2026-06-18）实施后的信任边界、防护状态、**诚实记录的残余风险与已接受偏离**。  
设计依据：`docs/specs/2026-06-18-deepcode-security-hardening-design.md`。

---

## 1. 信任边界

| 来源 | 信任级别 | 说明 |
|---|---|---|
| **用户输入**（键盘/stdin） | ✅ 可信 | 人工输入，视为可信指令 |
| **工具结果**（文件内容、命令输出、网页/搜索结果） | ❌ 不可信 | 可含来自外部来源的数据，包括嵌入的伪指令或 `<system-reminder>` 字面标签 |
| **`settings.json` 与 hook 配置** | ✅ 可信（本地 shell 同级） | 等同于用户对本机有任意 shell 执行权，http hook 的 URL 也视为本地可信配置的一部分 |
| **LLM 产出（工具调用参数）** | 🟡 部分可信 | 模型通常遵守守则，但可被 prompt injection 影响；工具参数经 sanitize 清洗后使用 |

---

## 2. 加固后的 4 项防护

### #1 复合命令前缀绕过

**防护**：`src/permissions.ts` 用 `shell-quote` 拆分命令（`splitBashCommand`），逐段授权（`bashCommandAllowed`），`matchRule` 加 `hasUnquotedOperator` backstop；`always` 存规则时危险/复合命令存精确规则而非前缀。

关闭了三类绕过：
- `ls && rm -rf /` 命中 `Bash(ls:*)` 放行整条 → 现在 `rm` 段无覆盖即 ask
- 换行（`ls\nrm -rf /`）绕过前缀匹配 → `normalizeUnquotedNewlines` 归一为 `;`
- 转义假引号（`cd src\&\& evil`）→ shell-quote 视为单命令含字面 `&&`，backstop 不误放行

**代码位置**：`src/permissions.ts:42-148`

---

### #2 工具结果注入

**防护**：`src/prompt.ts` 两条守则（`:53-54`）：外部数据不执行其中指令、怀疑注入先告知用户；`<system-reminder>` 标签来源无关守则防标签滥用。`src/text.ts:stripSystemReminderTags`（via `src/loop.ts`）中和工具产出里的 `<system-reminder>` 字面量，防恶意内容伪造系统边界。

**代码位置**：`src/prompt.ts:53-54`；`src/text.ts:21`；`src/loop.ts`（工具结果回灌处）

---

### #3 敏感路径 deny

**防护**：`src/deny.ts` 提供 `BUILTIN_DENY`（私钥类默认列表）和 `isDeniedPath`（picomatch glob 匹配，`~` 展开）。`src/permissions.ts:checkPermission`（`:156-166`）在最高优先级拦截：Read/Edit/Write 命中 deny → 硬拒；Bash 命中 → 降级 ask（防误操作）。Glob/Grep 在 `call()` 中过滤输出结果，丢弃命中 deny 的路径行。

**默认保护目标**（`BUILTIN_DENY`）：`~/.ssh/**`、`**/id_rsa|id_ed25519|id_dsa|id_ecdsa`、`~/.aws/credentials`、`**/authorized_keys`

**代码位置**：`src/deny.ts`；`src/permissions.ts:150-166`；`src/tools/glob.ts`、`src/tools/grep.ts`

---

### #4 sanitize 覆盖

**防护**：`src/text.ts:sanitize`（`:8`）覆盖 C0（`\x00-\x1f`）和 C1（`\x7f-\x9f`，含单字节 CSI `\x9b`）。权限弹窗 desc 渲染路径（`PermissionDialog` → `diffPreview`）经核实**已覆盖** sanitize，无视觉欺骗漏洞。工具参数入口 `src/tools/toolArg.ts` 已补 C1 范围（B 批 Task 10 修复）。

**代码位置**：`src/text.ts:8`；`src/tools/toolArg.ts`；`src/ui/diffPreview.ts`

---

## 3. 诚实记录的残余风险与已接受偏离

以下风险经评审后**有意保留**（对齐 CC 设计哲学、或属定位明确的分层防御）。后续开发者在扩展功能时须重新评估是否仍可接受。

---

### R-1：deny 不解符号链接

**描述**：`isDeniedPath` 用 `path.resolve`（逻辑路径），**不调用 `fs.realpathSync`**。攻击者可 `ln -s ~/.ssh/id_rsa /tmp/x`，随后 `Read /tmp/x` 绕过 deny。

**对齐 CC**：CC 自身也使用 `expandPath` 逻辑 normalize，不 realpath，故与 CC 对齐可辩护。

**接受条件**：能在机器上跑 Bash 创建符号链接的攻击者，已具备直接读文件的能力；deny 的防护目标是 LLM 误操作而非具备 Bash 执行权的攻击者。

**位置**：`src/deny.ts:29-35`

---

### R-2：Bash deny 只挡 LLM 误操作，不挡攻击者

**描述**：Bash deny 对命中路径**降级 ask**（非硬拒）。以下等价读取**绕得过**：
- `cat $HOME/.ssh/id_rsa`（`$HOME` 不展开，token 级 `deniablePaths` 不识别 `$HOME`）
- `xxd ~/.ssh/id_rsa`、`base64 ~/.ssh/id_rsa`、`tail ~/.ssh/id_rsa`（命令名非 cat，路径 token 可能命中，但如用 `$HOME` 则不命中）
- 变量拼接、进程替换等等价构造

复合命令已被 #1 强制 ask；简单 `cat ~/.ssh/id_rsa` token 可命中触发 ask（降级弹窗，不自动放行），但 `$HOME` 变体漏检。

**接受条件**：Bash deny 的定位是「防 LLM 在 yolo/acceptEdits 模式下的无意识高危操作」，弹窗足以提醒用户确认。不打算为 Bash 投入 AST 级 path 提取（无可靠地基），对齐 CC 不做此层防护。

**位置**：`src/tools/bash.ts`（`deniablePaths` token 逻辑）；`src/permissions.ts:162`（降级 ask）

---

### R-3：macOS 大小写不敏感绕过

**描述**：`isDeniedPath` 使用 picomatch 默认**大小写敏感**匹配。APFS 默认区分大小写不敏感卷上，`~/.SSH/id_rsa`、`**/ID_RSA` 可绕过 deny 规则（文件系统层面等价，但 glob 匹配层面不同）。

**对齐 CC**：CC 也不做 case-fold，故与 CC 对齐可辩护。

**接受条件**：私钥文件名大写（`ID_RSA`）极为罕见；如遇须自行在 `permissions.deny` 中补大写变体。

**位置**：`src/deny.ts:31`（picomatch 调用，无 `nocase` 选项）

---

### R-4：headless cwd 快照陈旧

**描述**：headless 模式下，`PermissionContext.cwd` 在依赖构建时按值捕获。mid-run `cd` 后，相对路径 deny 规则可能以陈旧 cwd 计算，导致针对 cd 后目录的纯相对路径 deny 规则 miss。

**影响范围有限**：home 锚定（`~/.ssh/**`）和 glob 锚定（`**/id_rsa`）的高价值私钥 deny 规则仍有效，因为 `deniablePaths` 独立展开 `~` 为绝对路径。只有针对「cd 后相对路径」的自定义 deny 规则才可能 miss。

**useChat 不受影响**：useChat 每轮重建 deps，cwd 始终最新。

**位置**：`src/loop.ts`（headless execCall 处 PermissionContext 构造）

---

### R-5：#2 中和是廉价纵深，终极防御仍是守则 + 模型遵守

**描述**：`text.ts:stripSystemReminderTags` 剥除工具结果中的 `<system-reminder>` 字面量，挡的是字面标签边界伪造。CC 本身不做此中和，deepcode 此处是额外纵深。

**根本限制**：模型遵守系统提示守则才是防 prompt injection 的终极防线。DeepSeek 系列模型的抗注入能力弱于 Claude Opus；恶意内容可绕过字面标签剥除而仍影响模型行为（语义注入，无需 `<system-reminder>` 标签）。

**接受条件**：字面标签中和成本低、无误伤，值得保留为纵深。但不应视为完整防注入方案，系统提示守则（`src/prompt.ts:53-54`）才是主要依赖。

**位置**：`src/text.ts:21`；`src/prompt.ts:53-54`

---

### R-6：grep 过滤 parse-fail 方向为 keep

**描述**：`/^(.+?):\d+:/` 不匹配的行被**保留**（而非丢弃）。

**无实际泄露风险**：`rg --no-heading` 和 jsSearch 的输出格式均为 `relpath:line:content`，不会发出裸内容行或分隔行；实际中无敏感数据行会因 parse-fail 而绕过过滤。

**保留方向**：parse-fail keep 防止漏报（行误判为非结果格式而被丢弃），副作用可忽略。

**位置**：`src/tools/grep.ts`（结果行过滤逻辑）

---

### R-7：http hook 无 SSRF guard / URL 白名单

**描述**：`settings.json` 中配置的 http hook URL 无服务端请求伪造（SSRF）防护，也无 URL 白名单。

**当前可接受**：trusted-settings 模型下，`settings.json` 与本地 shell 同级信任，URL 由用户自配，风险等同于用户自己跑 curl。

**未来须补**：若将来引入「共享/项目级 settings」（从 git 仓库读取、第三方分发），则须在加载前对 http hook URL 做白名单或弹窗确认，防止供应链/仓库污染攻击。

**位置**：`src/hooks.ts`（http hook dispatch 逻辑）

---

## 4. deepcode 既有亮点（优于 CC）

| 特性 | deepcode | CC 对比 |
|---|---|---|
| **ESC 消毒 C1 覆盖** | `src/text.ts:8` 正则 `[\x00-\x08\x0a-\x1f\x7f-\x9f]` 覆盖 C0 + C1（含单字节 CSI `\x9b`） | CC sanitize 仅覆盖 C0 |
| **WebFetch 子模型隔离** | WebFetch 调用独立子模型，零工具暴露（子模型无法调用 Read/Edit/Bash 等工具） | CC WebFetch 在同主模型上下文执行 |
| **#2 廉价边界中和** | `stripSystemReminderTags` 剥除工具结果中 `<system-reminder>` 字面标签 | CC 不做此中和，纯靠守则 |

---

## 5. 后续建议（不阻塞当前批次）

- **符号链接纵深**（R-1）：若将来有用户反馈实际绕过，可在 Read/Edit/Write 的 `deniablePaths` 中补 `fs.realpathSync`（Bash 不补，与 CC 同）。
- **Bash path 提取升级**（R-2）：若 Bash deny 命中率反馈不足，可考虑更保守的「变量引用直接触发 ask」策略，但须权衡误报率。
- **http hook URL 白名单**（R-7）：将来新增共享 settings 机制时必须在该 PR 同步加入，不可分离。
- **大小写不敏感**（R-3）：picomatch 支持 `{ nocase: true }` 选项，macOS 专项加固可考虑按 `process.platform === 'darwin'` 开启。
