# M8 P2 验收报告：鼠标/触控板滚轮 +（同批）P1 全屏修复

**日期：** 2026-06-15
**版本：** v0.7.1-m7（本地 annotated）
**验收结论：** DONE ✅

---

## 范围

本批一个提交（`91d4a45`）含两件，都来自用户 `npm start` 真机试用反馈：

1. **M8 P1 修复**：全屏模式下「欢迎页消失」+「输入框钉底中间大空白」两个 bug。
2. **M8 P2 滚轮**：鼠标/触控板滚轮滚历史（P1 只有键盘 PageUp/PageDown）。

---

## P1 修复

### Bug 1：欢迎页消失（alt-screen 进入时机错）

按 `superpowers:systematic-debugging` 定位：探针证实组件树 banner 能渲染、`scrollOffset` 恒 0、FullscreenApp 在渲染（排除路由）；**捕获 ink 真实 stdout 写入**锁定根因——

`enterAltScreen` 原在 `FullscreenApp` 的 `useEffect` 里（ink 首帧之后才跑）→ ink 先把首帧画到主屏、effect 再 `\x1b[2J\x1b[H` 切屏归位 → 与 ink log-update「光标在上帧底部」假设冲突致整屏错位、banner 顶出。

**修**：alt-screen 移到 `startTui` 在 `render()` **之前**同步进入（`startTui` 拥有进出 + 信号还原；`FullscreenApp` 不再于 effect 进）。

### Bug 2：输入框钉底大空白

用户钦定「**内容少时输入框贴内容、超一屏才钉底**」。`ScrollView` 从 `flexGrow` 改为显式 `height = min(totalH, availableH)`（`availableH = rows - bottomH`，`bottomH` 由 `bottomRef` measureElement 量）。

**修了测量死锁**：`totalH=0` 时 0 高容器把内层也量成 0 → `scrollH = totalH>0 ? min(totalH,avail) : avail`。IME 停泊改内容相对定位 `caretRow = scrollH+1+aboveInput+2`，un-park 移回 `frameH`（实际渲染底）非 `rows`。

**已真机验证 OK**（banner 出现、随对话滚入历史、输入框跟随）。

---

## P2 滚轮

探针确认 ink 把鼠标 SGR 序列当普通 input 传（`[<64..M`=上滚、`[<65..M`=下滚，无 key flag）→ 会污染输入框。**方案 = 喂 ink 前过滤**。

新文件：

| 文件 | 职责 |
|---|---|
| `src/tui/mouseStdin.ts` | `PassThrough` 代理 tty 方法；`parseWheel` 纯函数剔除所有鼠标 SGR 序列（防污染输入框）、滚轮转方向（纯函数全单测） |
| `src/tui/wheel.ts` | 滚轮事件 pub/sub |

改动：

- `src/tui/altscreen.ts` / `startTui` — 进全屏时开 SGR 鼠标捕获 `\x1b[?1000h\x1b[?1006h`，退出时关。
- `src/tui/index.tsx` — `render` 传自定义 `stdin`（`mouseStdin` 代理）。
- `src/tui/FullscreenApp.tsx` — 订阅 `onWheel` 滚（每格 3 行）。

---

## 提交清单

```
91d4a45 fix(M8 P1)+feat(M8 P2): 修欢迎页消失 + 输入框跟随内容 + 鼠标/触控板滚轮滚动
49928ce docs(M7②): rewind 设计补稳定 turnId 机制
```

---

## 测试与冒烟

- 新增单测：`parseWheel` 5（过滤鼠标序列 + 滚轮转方向）。
- 合入 main 后全量 **277 测试全绿**，typecheck/build 干净。
- **pty 真终端冒烟（用户 2026-06-15 确认全过）**：
  - 滚轮：超一屏内容触控板/滚轮上下滚看历史 ✓
  - 滚时输入框/页脚**不冒乱码**（`[<64…` 序列被过滤）✓
  - 滚到底自动跟随 ✓
  - 打字 / `/exit` 正常（**自定义 stdin 与 ink 兼容**）✓
  - 中文 IME 组字在框内 ✓

---

## 已知接受风险（不阻塞）

| 风险 | 说明 |
|---|---|
| 鼠标捕获接管拖拽选中 | 开 `?1000h` 后鼠标拖拽被接管；**Shift+拖拽**走终端原生选中；应用内选中 = P3 |
| 自定义 stdin 代理 | `PassThrough` 代理 tty 方法喂 ink；冒烟已验证打字/退出正常；逃生 `--inline` 兜底 |

---

## 带入

M8 只剩 **P3 应用内选中复制**（`pbcopy` 已在；鼠标捕获已接管拖拽，P3 做应用内选区高亮 + 复制，待 brainstorm）。
