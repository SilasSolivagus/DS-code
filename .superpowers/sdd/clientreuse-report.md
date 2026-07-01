# fix(auto-mode): 复用分类器 client 避免每次新建 ProxyAgent

## 变更

**文件：** `src/autoMode.ts`

- 新增 module-level lazy singleton：`_classifierClient: OpenAI | undefined`
- 导出 `getClassifierClient()` — 首次调用时 `createClient()`，后续调用返回同一实例
- 导出 `__resetClassifierClient()` — 测试辅助，重置 singleton
- `defaultCall` 中将 `const client = createClient()` 改为 `const client = getClassifierClient()`

其余逻辑（temperature 0.2、thinking gating、withRetry）完全不变。

**根因：** `defaultCall` 每次分类器调用都构造新的 OpenAI 客户端（内含 undici ProxyAgent），走代理时每次都付完整握手代价，偶现 50+ 秒卡顿。主模型循环全程复用一个 client，所以 default 模式快、auto 模式慢。

**修复安全性：** `activeProvider()` 已 memoized，运行时 provider 锁定，同一 baseURL/key 的单例客户端与现有设计一致。

## 测试（`test/autoMode.classify.test.ts`）

新增 describe 块：`分类器 client memoize`

- `vi.doMock` mock 掉 `../src/api.js`，让 `createClient` 返回固定 sentinel 对象
- `vi.resetModules()` + `__resetClassifierClient()` 确保 singleton 干净
- 断言：`getClassifierClient()` 连续两次调用返回 `toBe` 同一实例
- 断言：mock 的 `createClient` 仅被调用一次（核心回归门）
- 完全 hermetic，无网络、无密钥依赖

## 结果

| 项目 | 结果 |
|------|------|
| memoize 测试 | PASS — c1 === c2，createClient called once |
| 全套测试 | 209 files / 1518 tests passed |
| tsc build | clean (0 errors) |
