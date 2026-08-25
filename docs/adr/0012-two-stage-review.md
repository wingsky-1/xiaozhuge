# ADR 0012: oss-maintenance 两阶段核验（规格/成品双任务拆分）

- 状态：Accepted
- 日期：2026-08-26
- 对应 issue：#46 [MVP] spec-review 与 code-review 环节承载（v2 提案获批）

## 背景

P6b 实跑暴露：规格质量与实现质量的核验由 qa 一肩挑且只在 review 阶段发生，
规格缺陷要到成品复核才被发现，返工半径大。对抗性评审进一步证实：「deciding
尾部」无机制挂点、stages 为纯标签、核验输入通路未定义、fail 后 cancelled+
重建会洗掉 rounds 击穿收敛。

## 决策

1. **条目拆双任务**：每条目登记 `<条目>-spec`（dod = 规格三条）与
   `<条目>-impl`（dod = 规格验收节）两个账本任务；**spec 任务经 qa 核验
   pass 并 done 后才创建 impl 任务**——「核验先于放行」由任务创建顺序
   结构性保证，不依赖提示词自觉，零框架改动。
2. **qa 两阶段核验**：规格核验 = 对照来源的覆盖性核对 + 可判定性核对；
   成品核验照旧。briefing 扩为 background+acceptance 两节以支撑对照。
3. **返工语义**：核验 fail 一律原地 blocked + 计圈定向返工，禁止取消重建
   洗掉 rounds（防绕过收敛与 R2/R3 计数）。已知局限如实记录：R2 的
   「无进展」判据对「有事件流的活锁」不敏感，靠计圈口径补足。
4. **记忆备份条款**（维护者追加）：以目标仓库 issue 与 PR 作为实施过程
   记忆载体——目标与阶段性成果回写 issue、变更以 PR 承载；账本记状态、
   issue 记叙事、PR 记证据。
5. **安全条款**：核验回执引用外部内容一律截引，不得整段转发。
6. **编排并行口径**：条目内严格串行（spec → 核验 → impl → 复核）、条目间
   流水线并行（受 max_active_rooms 约束）；微条目可豁免 spec 阶段；
   qa 信封优先级 成品核验 > 规格核验。
7. **判定持久化**：qa 回执落 run-log 归档，状态级重建后已 pass 的核验不重做。

gate 人审对象语义变化：从「未评审的计划」变为「已过规格核验的实现任务」。

## 影响面

- `templates/oss-maintenance/prompts/{master,issue-master,qa}.md`；
  `roles/qa.role.yaml`（briefing 扩节 + dod 增补）；模板 README 同步。
- research-report 不受影响（其 judge 是 reviewer，本就非 qa）。
- 零框架代码改动；校验器 briefing 枚举（background/boundary/acceptance/
  forbidden）内合法扩展。

## 备选方案

| 备选 | 被否理由 |
| --- | --- |
| 新增独立 reviewer 角色 | 两跳判定链 MVP 偏重；as_judge 唯一性下只能出意见不裁决，徒增往返 |
| issue-master 兼任 review | 中间层既编排又判定，自产自检利益冲突 |
| gates 改绑 stage-enter:running | queued/running 都是 LLM 自主推进态，治不了时序自觉问题（执行器缺失见 #53） |

## 回滚方式

还原模板文件即恢复单阶段核验口径；双任务仅为编排惯例，存量数据无迁移。
