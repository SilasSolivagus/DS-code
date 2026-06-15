// src/keybindings.ts
/** 返回分组的快捷键展示串，供 /keybindings 命令静态展示。零副作用。 */
export function formatKeybindings(): string {
  return [
    '快捷键',
    '',
    '【输入框】',
    '  Esc — 生成中时中断当前回合；空闲时清空输入框',
    '  Enter — 提交（补全菜单激活时由菜单接管 Enter）',
    '  行尾 \\ + Enter — 续行（多行输入）',
    '  ↑ / ↓ — 浏览历史输入（补全菜单激活时由菜单接管）',
    '  Backspace / Delete — 删除字符',
    '  Tab — 补全菜单导航',
    '',
    '【滚动】',
    '  PageUp / PageDown — 上/下翻页滚动历史',
    '  Ctrl+G — 跳到底部并恢复自动跟随',
    '  Ctrl+C — 连按两次（2 秒内）退出',
    '  鼠标 / 触控板滚轮 — 上下滚动',
    '',
    '【触发】',
    '  / — 斜杠命令菜单',
    '  @ — 文件引用菜单',
    '  ! — 直跑 shell 命令',
    '',
    '【选中】',
    '  Shift + 拖拽 — 终端原生选中（鼠标已被滚轮捕获，故需 Shift）',
  ].join('\n')
}
