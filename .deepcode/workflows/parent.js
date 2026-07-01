export const meta = { name: 'parent', description: '父 workflow：调用子 workflow（验 workflow() 嵌套+共享计数）' }
phase('Parent')
const a = await agent('用一句话说"我是父 workflow 的 agent"。', { label: 'parent-agent' })
phase('Child')
const b = await workflow('child', {})
return { parent: a, child: b }
