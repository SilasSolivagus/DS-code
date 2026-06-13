# M5 验收报告（抄 CC 手感的 ink TUI + DeepSeek 辨识度）

日期：2026-06-13。范围：ink 5 TUI（Banner/Transcript/ToolLine/InputBox/Suggestions/PermissionDialog/StatusLine/SelectList）+ markdown 渲染 + 鲸鱼蓝主题 + 思考折叠块 + 缓存命中率/tok-s 状态行 + `!` 直跑 + `@` 文件引用 + 模型/baseURL 可配 + 入口分流（TTY→TUI / `--plain`→旧 repl / 非 TTY→headless）。

计划：`docs/plans/2026-06-13-deepcode-m5.md`（Task 1-11 会话一完成，Task 12 = 本验收 + 前置补丁批 P1-P4）。
测试 116 → 184（33 文件），typecheck 干净。

## 前置补丁批 P1-P4（用户试玩反馈 + 验收发现）

| 补丁 | commit | 内容 |
|---|---|---|
| P1 权限弹窗 CC 式方向键菜单 | `4e33e78` | `❯ 允许 / 总是允许 / 拒绝` ↑↓+Enter，y/n/a 快捷键 + Esc=拒绝 保留，高危警告行不变 |
| P2 工具预览 ANSI 清洗 | `dc7ed0d` | sanitize 提取到核心层 `src/text.ts`，diffPreview 与 loop.previewOf 共用；剥 C0+DEL，previewOf 先 split 取首行再清洗 |
| P3 系统提示词两条 | `b4e7d6f` | ①需求歧义先一句话确认再动手 ②Bash 无 tty，curses/交互式程序跑不动、用户无法向子进程输入，让用户自己开终端 |
| P1/P2 审查 follow-up | `d98eba7` | PermissionDialog `idx` 随 ask 重置（防连续弹窗误授）+ sanitize 加剥 C1 区（`\x9b` 单字节 CSI） |
| P4 斜杠命令死锁修复 | `5eaa22a` | **验收发现的阻断 bug**（见下） |

每补丁过规格审查 + 质量审查双门（P1-P3 由实现/审查 subagent；P4 由主控亲自 TDD + 一次合并审查）。

### P4：验收发现的阻断 bug

**现象**：键入完整斜杠命令全名（`/exit` `/think` `/clear` 等）后回车死锁——补全菜单永久接管回车，命令既不提交也不退出，只能 Ctrl+C。

**根因链**：`computeSuggestions('/exit')` 对精确全名仍返回该单项菜单 → `Suggestions` 吞掉回车（`InputBox` 在菜单激活时回车 no-op）→ `App.handlePick` 把 `draft` 设成它本就等于的 `/exit` → `App` 的 `suggestions` useMemo 只依赖 `[draft]` 不重算 → `justPicked` 抑制永不生效 → 菜单永久存在。用 `/` 列表 ↑↓ 选中再回车的路径正常（那里 `draft` 真实从 `/` 变 `/exit`，useMemo 重算）——故此前试玩/冒烟未撞上。

**修复**（用户钦定「立即修，贴 CC」）：`src/tui/suggest.ts` 斜杠分支内 `if (filtered.length === 1 && filtered[0].value === input) return []`——输入精确等于某命令全名时隐藏菜单，回车直接提交（与 CC 一致，一次回车即执行）。用 `length===1 && value===input` 而非松散 `some(...)`，为未来共享前缀命令保留菜单。已枚举 BUILTIN 12 命令确认无一互为前缀，守卫安全。

## Step 1：视觉/手感清单（pty 自动 + 待人工核对）

pty 冒烟脚本 `/tmp/ds-smoke/{smoke.py, p4.py}`（真 pty fork+exec `tsx src/index.ts`，30×100，只发本地操作不触发 API）自动核对：

| # | 项 | 方式 | 结果 |
|---|---|---|---|
| 1 | Banner 含 🐳 deepcode | pty 文本断言 | ✅ |
| 2 | 输入框 placeholder | pty 文本断言 | ✅ |
| 3 | `/` 浮出命令菜单（/model、/resume…） | pty 注入 `/` | ✅ |
| 4 | `@` 浮出文件菜单（模糊匹配 cwd 文件） | pty 注入 `@` | ✅ |
| 6 | `!` 直跑 bang 块输出 | pty 注入 `!echo …` | ✅ |
| 10 | 状态行：缓存命中率 + tok/s 常驻 | pty 文本断言 | ✅ |
| — | 鲸鱼蓝 accent 颜色码 `38;2;77;107;254` | pty 原始字节断言 | ✅ |
| 12 | Ctrl+C×2 退出 | pty 注入 `\x03\x03` | ✅ |
| 13/15 | `/exit` 全名**单次回车**退出（P4） | pty 注入 `/exit\r` | ✅（修复前死锁） |
| 8 | Edit 权限弹窗 ±diff 着色 + ❯ 方向键菜单 | 组件测试 `tui.permission.test.tsx` | ✅（181→含方向键/重置/C1 用例） |
| 9 | 高危 Bash 红色 ⚠ 警告 | 组件测试 | ✅ |

**待用户真终端人工核对**（纯视觉/感知，pty 抓不到、主控无法判定）：
- 颜色实际呈现（鲸鱼蓝边框/提示符/选中态、思考块紫色斜体、diff +绿/−红、高危红）
- 项 5：流式 markdown 渲染（标题/代码高亮/表格）观感
- 项 6：工具行运行中 spinner → `⎿` 预览+耗时 的动态过渡
- 项 7：`/think` 后 `✻ 思考中…` 紫色流 → 完成折叠为一行
- 项 11：Esc 流式中断 / 空闲清空输入
- 项 14：历史 ↑ 调出上一条输入
- 项 15：`/resume` 列表选择恢复、上下文连续
- IME 组字光标定位（已知 M6 攻坚项，非本批）

## Step 2：功能回归（待人工）

待用户真终端交互核对：`/compact` 后 `/context` 数值下降 + 追问连续；TodoWrite 长任务 todo 渲染；`/permissions` 增删规则生效。headless 路径（`-p --json`）逻辑未动，由 184 单测 + bench 覆盖。

## Step 3：bench 快速回归

`bench/run.ts --runs 1 --track deepcode --scenario s1-assembler,s6-fix-bug,s12-injection`：**3/3 通过**（s1 4 工具/37s、s6 9 工具/15.3s、s12 2 工具/4s）。P3 提示词改动未致退化。结果文件已备份 `bench/results/2026-06-13-m1.*.bak-pre-p3`。

## 破坏性变更

- **非 TTY 管道喂入语义变更**：旧版管道喂 REPL，M5 改为非 TTY stdin（无 `-p`）读全文当 prompt 走 headless（CC 同款）。逃生舱：`--plain` 强制旧 readline REPL。
- 默认入口从 readline REPL 改为 ink TUI（`--plain` 回退）。

## 带入 M6

- **package.json 版本号停在 0.1.0**，banner 显示 `v0.1.0`（里程碑只靠 git tag）；M6 安装/首跑向导时一并校正版本来源。
- 斜杠命令补全菜单：完整命令名现一次回车提交（P4），但 `/model pro` 等带参命令的「选中命令名后接着打参数」体验未单独打磨。
- repl.ts 与 useChat 双份状态机（旧版冻结，M6 评估删除）。
- 用户钦定 M6：安装/首跑向导（npm 全局包 + key 配置 + logo 欢迎页）、AskUserQuestion 工具（TUI 菜单/headless 禁用）、IME 光标定位攻坚、行内编辑（←→）、`!` 交互透传（stdio inherit）、可写 subagent+worktree、WebFetch、/rewind。

## 验收结论

结构/功能/回归层面（184 测试、pty 冒烟 9 项 + P4、bench 3/3、组件测试覆盖权限弹窗）全绿。**纯视觉/感知层面待用户真终端核对上述清单后签收，再打 tag `v0.5.0-m5`。**
