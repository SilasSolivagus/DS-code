// DeepSeek 主题：鲸鱼蓝 accent 是全 UI 唯一强调色，其余克制（dim 为主）
export const T = {
  accent: '#4D6BFE',   // 鲸鱼蓝：边框、提示符、选中态、banner
  reasoning: '#9B7EDE', // 思考流紫（逐步淘汰：CC 思考流用 dim 灰，Task 4 改造 Transcript 后移除）
  ok: '#4ADE80',
  err: '#F87171',
  warn: '#FBBF24',
  dim: 'gray',
} as const

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// CC 风格工作 spinner：星号动画帧 + 中文俏皮动名词（CC 轮换 Cogitating/Pondering 等）
export const SPINNER_SYMBOLS = ['✻', '✳', '✶', '✺', '✹', '✷']
export const THINKING_VERBS = ['琢磨中', '盘算中', '捣鼓中', '思索中', '合计中', '拾掇中', '盘点中', '鼓捣中', '推敲中', '寻思中']
