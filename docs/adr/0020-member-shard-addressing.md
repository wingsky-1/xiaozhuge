# ADR 0020: 黑板分片按 member 寻址 + 重复派发拒绝（Q5 命名落地）

- 状态：Proposed
- 日期：2026-08-29
- 对应 issue：#159（Q5/Q6 PR-3b，红线，state/approved）
- 评审留痕：#159 方案评审评论（独立对抗性评审 approve-with-fixes 无 P0 + 用户授权 approve 实施）

## 背景

#147 Q5 设计定稿（2026-08-28，用户裁决）：多实例同 role（如两个 researcher）时
member 名 = `<role>-<会话id/随机串>`，黑板分片文件从 `state/<role>.json` 改为
`state/<member>.json`（schema 变更——现状按 role 名寻址，多实例同 role 互覆）。
另：重复注册拒绝基于 `(role, task_id)` 组合（评审修正——仅 member 名唯一不够）。

Q6（#150）PR-1/2/3a 已合入（状态机、存量兼容、assignee 当前受理人）；本 ADR 承接
Q5 定稿的框架侧落地（原 Q6 PR-3b）。

## 决策

1. **黑板分片按 member 寻址**：`state/<role>.json` → `state/<member>.json`，
   分片键 = 调用者成员名（stateSet 已 requireSelf 限自身，成员名全局唯一）。
   - **无后缀剥离回退**（评审否决后缀剥离）：存量会话 member 名 = 纯 role 名时
     `<member>.json` 与旧路径 `<role>.json` 同名，路径天然一致，无需迁移脚本；
     后缀剥离会把已死实例的旧分片嫁给活实例（数据正确性 bug），且 role 名可含
     `-` 使剥离不可靠——否决。
   - `Shard.role` 字段值保留成员名（字段名 "role" 为历史债）：视图层
     （overview/detail）以 `shard.role === 成员名` 匹配着色，零改动。
   - `listShards` 原样返回旧归档文件（Shard.role=旧成员名），overview 按成员名
     in-set 匹配自然忽略、detail 全平铺如实展示。
2. **重复派发拒绝**：`team_dispatch` 前置校验（半事务之外，纯读账本）——
   `task.assignee !== undefined && task.assignee !== member` → 拒，错误码
   `duplicate-dispatch`。判据 = assignee 占用（`(role, task_id)` 的充分条件，
   顺带覆盖换不同 role 派发已分配任务的越权面）；`assignee === member` 放行
   （半事务失败重试的幂等口子，at-least-once）。**不在 upsertMember 实现**——
   注册层无 task_id/role 维度，`(role, task_id)` 不可判（否决伪选项）。
   换持有者走 `team_handoff`（requireHolder + update），不经 dispatch，不受影响。
3. **member 名格式约定（提示词层）**：框架侧 schemas.ts 仅声明 member 为字符串
   （不强制格式）；`dispatch/spawn.member` 描述文案改为实例名口径（引导 LLM），
   `stateGet.role` 描述改 member shard 口径；两套模板 master.md 补「实例名铁律」
   （首实例可用纯 role 名或实例名，第二个同 role 实例起必须带唯一后缀）。
4. **member 分片键白名单**（评审 P2-5，采纳）：`[A-Za-z0-9._-]`，非法键拒绝
   （错误码 `invalid-shard-key`）——member 名直接拼文件路径，防注入越出 state 目录。
5. **不新增 MemberRecord.role 字段**（评审 P2-6，记录为后续项）：本 PR 判据
   已不依赖前缀解析；命名与角色判定解耦待 Q3 事件流化时评估。

## 备选与裁决

- **`(role, task_id)` 按 member 名前缀解析判定**：否决——需要假设
  `<role>-<id>` 格式且 role 名可含 `-`（如 issue-master），剥离不可靠；
  与「schemas 不强制格式」自相矛盾。
- **后缀剥离旧名回退读**：否决——死实例分片嫁接活实例（数据正确性 bug），
  且兼容性由路径天然一致保证，回退代码无用且有害。
- **在 upsertMember 实现重复拒绝**：否决——注册层只有 MemberRecord
  （无 task_id/role 字段），判据无从建立；实现位只能是 dispatch 前置。

## 后果

- 正面：多实例同 role 分片互不覆盖；重复派发有确定性错误码与幂等口子；
  真实 LLM 调用经 schemas/模板铁律引导使用实例名，避免验收依赖测试强制。
- 负面/风险：`Shard.role` 字段名与语义（存 member 名）不一致是历史债，ADR 记录；
  既有调用方用纯 role 名派发仍兼容（首实例路径同名）。
- 兼容性：旧分片文件读取原样返回；运行中升级路径天然一致；#96 orphan 检测
  整名 in-set 无前缀假设，新旧格式 member 名均精确匹配，天然兼容。
- 流程：黑板分片寻址 = 目录协议/持久化面变更 = 红线，已随 #159 获 `state/approved`
  （独立对抗性评审 approve-with-fixes 无 P0 + 用户授权）；先本 ADR（同步于代码 PR），
  后代码 PR，各自过全量门禁。