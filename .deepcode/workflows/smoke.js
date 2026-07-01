export const meta = {
  name: 'smoke',
  description: '冒烟：并行读两个文件 + 汇总（验 phase/parallel/agent+schema/真工具）',
  phases: [{ title: 'Scan' }, { title: 'Summarize' }],
}

phase('Scan')
const findings = await parallel([
  () => agent('读取本仓库 package.json，只用一句话报告它的 "name" 字段值。', {
    label: 'pkg',
    schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  }),
  () => agent('用 ls 看看 src/workflow/ 目录下有哪些文件，一句话列出。', { label: 'list' }),
])

phase('Summarize')
const summary = await agent('把这些发现汇总成一句话：' + JSON.stringify(findings), { label: 'summary' })

return { findings, summary }
