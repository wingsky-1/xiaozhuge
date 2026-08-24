<!-- 关联 issue：Closes #NNN（zone/red-line 任务必须链接已 state/approved 的决策 issue） -->

## 变更内容

<!-- 做了什么，为什么；一段话讲清 -->

## 自验凭据

<!-- 工具输出指标 + 结果摘要，不接受自然语言自评 -->

- [ ] `pnpm lint && pnpm typecheck && pnpm build` 全绿
- [ ] `pnpm test` 全绿，新增/变更行为有用例覆盖
- [ ] `pnpm cov` 达到覆盖率基线（70）
- [ ] `pnpm mutation` 不低于变异得分基线（70，增量模式）

## 变更半径

- [ ] 未触碰红线（协议不变量 / team_* 工具面 / 新依赖 / `.github/`）；若触碰，已链接 state/approved 决策 issue
