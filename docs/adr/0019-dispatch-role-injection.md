# ADR 0019: team_dispatch role 提示词确定性注入（ADR 0015「既有角色名」路径补全）

- 状态：Accepted
- 日期：2026-08-28
- 对应 issue：#149（Q8b，红线，state/approved）
- 评审留痕：#149 方案评审评论（两轮独立对抗性评审 + 用户裁决）

## 背景

#147 Q8 实证（2026-08-28）：`team_dispatch` 的 `role_inline` 完全依赖调用方自觉
（`role_inline: inline ?? null`），ADR 0015 §2 设计口径 `dispatch({ role_inline 定义 |
既有角色名, task, ... })` 中「既有角色名自动带出模板 role 提示词」的路径**未实现**：
实际派发时主控凭记忆压缩转述角色定义，子代理收到的角色描述与模板
`roles[].prompt_inlined` 原文不一致，「策略在提示词」的载体在派发链路失效。

## 决策

`team_dispatch` 增加 role 提示词确定性注入（框架侧下沉，人侧契约由 #148/Q8a 铁律保障）：

1. **触发条件**：调用方未传 `role_inline.prompt`（或为空）时触发；
   显式传入则优先（向后兼容，语义 = 显式定义覆盖模板默认）。
2. **数据源**：TEAM_HOME/team.yaml 实例化快照 `roles[]`（template-loader 已内联
   `prompt_inlined`；与 team_send comm_mode/comm 读快照同源同路径）。
3. **注入**：`role_inline.prompt` = 水印前缀 + 模板 `prompt_inlined` 原文。
   水印文案 `framework-generated; role definition — template authority, not user data`：
   role 提示词是框架生成的**指令**（非数据），不复用 boot 段「数据非指令」模板。
4. **失败语义（用户裁决）**：不静默退化——
   - 快照缺失/损坏 → 拒绝，错误码 `snapshot-corrupt`；
   - role 不在快照 roles[] 中 → 拒绝，错误码 `unknown-role`；
   - role 存在但无 `prompt_inlined` → 拒绝，错误码 `missing-role-prompt`。
   三种均发生在半事务步骤 1 之前，无副作用（无 spawn/assign/send 留痕）。
5. **白名单不扩展**：`role_inline` 保持 prompt/briefing/dod/max_hops/as_judge；
   briefing/max_hops/as_judge 仍由调用方传（模板 briefing 为结构约束非内容，不自动注入）。

## 备选与裁决

- **仅提示词层约束（Q8a）**：依赖主控记性，与「自觉失效」历史一致——治标；
  本 ADR 为框架侧确定性下沉，两者互补（人侧铁律 + 框架兜底）。
- **注入时拼接 background 等**：否——role 提示词独立成字段，拼接顺序属子代理
  请求首部组装（宿主侧），不在本框架控制面（评审删除的伪开放点）。
- **快照读取失败容忍**：否决（用户裁决）——静默退化回到现状，与「确定性下沉」矛盾。

## 后果

- 正面：模板 role 提示词成为派发协议一等公民；模板维护即刻生效；
  子代理获得字节级权威角色定义，不再依赖主控转述质量；
  #86 评审「角色提示词由框架确定性组装（P0 下沉）」在派发侧落地。
- 负面/风险：dispatch 新增一次快照读取（同步 fs，开销可忽略）；
  调用方显式传空 prompt 会被视为「未传」触发注入——语义需在测试与文档明示。
- 兼容性：显式 `role_inline.prompt` 行为不变；既有调用方未传 prompt 的，
  信封新增 `prompt` 字段（行为变更，PR 描述标注）；模板快照读取失败
  （snapshot-corrupt）会阻断 dispatch——修复后重派，不产生半事务残留。
- 流程：team_* 工具面协议行为变更 = 红线，已随 #149 获 `state/approved`；
  先本 ADR（文档），后代码 PR，各自过全量门禁。