# 开发指南

> 本文件是提交前必做动作的唯一事实源；`AGENTS.md` 与 `README.md` 引用此处，
> 不重复展开。命令与门禁基线以根目录配置为准（`package.json` / `ci.yml` / `stryker.conf.json`）。

## 提交前必做动作（按序执行）

```bash
pnpm install --frozen-lockfile   # 1. 依赖安装（lockfile 必须一致）
pnpm lint                        # 2. 静态检查（最快，先失败先暴露）
pnpm typecheck                   # 3. 类型检查（含 tsconfig.client.json 客户端面）
pnpm build                       # 4. 构建 —— 必须先于 test，原因见下
pnpm test                        # 5. 全量测试
pnpm cov                         # 6. 覆盖率门禁（全局四维 >= 70）
```

全绿 = 完成定义。**顺序不可调换，尤其 `build` 必须在 `test` 之前**：

- `tests/plugin/team-launch.test.ts` 断言 `dist/client.js` 构建产物契约；
- `tests/runtime/dual-process.test.ts` 以编译后的 `dist/runtime/kernel/cas-lock.js`
  spawn 双进程验证跨进程锁语义。

跳过 build 直接 test 会因产物缺失而失败——这是**有意设计**而非缺陷：
测试硬性校验真实产物，不设条件跳过；CI 通过 job 内步骤顺序保证产物存在
（gauntlet：install→lint→typecheck→build→test→cov；mutation：install→build→mutation）。

## 可选但推荐

```bash
pnpm cov:patch    # 增量覆盖率：本次变更行 >= 80%（需 pip install diff-cover），CI 同款门禁
pnpm mutation     # 变异测试（增量模式，得分基线 70）；跑完若 stryker-incremental.json 有变化须一并提交
```

## 为什么有这些门槛（一句话版）

| 动作 | 拦住的问题 |
|---|---|
| `typecheck` 含 client tsconfig | 浏览器端插件与服务端的类型漂移 |
| `build` 先于 `test` | 契约测试对「上次构建的陈旧产物」误报 |
| `verify-client.mjs`（内嵌于 build） | client bundle 的 loader 注入契约破坏 |
| `cov` + `cov:patch` | 新代码无测试覆盖 |
| `mutation` + 基线新鲜度校验 | 断言弱化（变异体存活） |

## 工作方式约定

- 一切修改优先走独立 `git worktree`（见 `AGENTS.md` 第 12 条）；
- 功能分支 + PR，CI 全绿后 squash merge；
- 小步提交，Conventional Commits（禁止 emoji）；
- 红线变更（公共 API/协议、新增依赖、`.github/` workflow 等）须先经 issue 方案评审
  （见 `AGENTS.md` 第 3 条）。

## 常见坑

| 症状 | 原因与处置 |
|---|---|
| `ENOENT ... dist/client.js` 或 `dist/runtime/kernel/cas-lock.js` | 没 build 就跑 test；按上文顺序重来 |
| pnpm 报 `Ignored build scripts: esbuild` | `pnpm-workspace.yaml` 的 `allowBuilds.esbuild` 缺失或未置 `true` |
| CI mutation 失败但本地全绿 | 本地跑过 build 而 CI 沙箱靠 job 步骤保证——确认 workflow 中 build 在 mutation 前 |
