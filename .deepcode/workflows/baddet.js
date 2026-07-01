export const meta = { name: 'baddet', description: '故意含 Date.now，应被确定性校验拒绝' }
const t = Date.now()
return await agent('随便说一句，当前时间戳 ' + t)
