export const meta = { name: 'child', description: '被嵌套调用的子 workflow' }
return await agent('用一句话说"我是子 workflow 的 agent"，并报告 src/ 下有几个 .ts 文件（用 ls/grep 估）。', { label: 'child-agent' })
