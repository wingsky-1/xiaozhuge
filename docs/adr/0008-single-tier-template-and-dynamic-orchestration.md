# ADR 0008: 单层模板放宽（tiers 下限 1）与主控动态编排

- 状态：Accepted
- 日期：2026-08-25
- 对应 issue：#39 [feature] 通用资料编写模板 research-report（state/approved）

## 背景

v2.2 定稿与 P2b 校验器把 Team Template 的层数锁定为 2~3 层（`tiers-length`
约束 `.min(2).max(3)`），隐含「必有中间层」的多级团队形态。issue #39 要求新增
通用资料编写场景：一层主控直接调度执行者角色池（收集 / 验证 / 整理 / 编写 /
复核），由主控按任务形态**动态编排**——不预设串行阶段闸门。该形态在轻量任务下
更简单、延迟更低；强制两层会逼出无实质职责的「传声筒」中间层。

层数下限属公共协议行为变更（红线），已按流程在 #39 获 `state/approved` 后实施。

## 决策

1. **校验器放宽**：`validateTeamTemplate` 的 tiers 约束改为 `.min(1).max(3)`，
   稳定错误消息同步改为 `template requires 1 to 3 tiers`（错误码 `tiers-length`
   不变）。上限 3 不动。
2. **单层语义**：tiers 仅含 master 时，master 即唯一调度者，直接对全部角色派单
   与收单；协议词汇（task / mailbox / blackboard / gate / archive）不变，
   仅层级数为 1。
3. **编排策略归提示词层**：串行/并行、启用哪些角色、回退路径一律由场景模板的
   master prompt 承载（「策略在提示词，动作用工具」），框架层不引入阶段编排机制。
4. **首个单层内置模板**：`templates/research-report/`（ADR 0002 三件套结构），
   五角色 researcher / verifier / organizer / writer / reviewer，reviewer 为
   唯一 judge。模板保持通用，不含任何真实业务域词汇。

## 备选方案

| 备选 | 被否理由 |
| --- | --- |
| 保持 2~3 层，research-report 套两层壳 | 中间层无实质职责，徒增 handoff 开销与故障面 |
| 框架层引入阶段编排原语（pipeline/stage） | 违背「策略在提示词」；动态编排用现有 task/send 原语即可表达 |
| 放宽至 0~3 层（允许无主控） | 单入口原则要求必有且仅有一个主控，0 层无意义 |

## 影响面

- `src/runtime/template.ts` 校验器与错误码表；既有负例测试的触发构造
  （单层不再触发下限，改用 4 层触发上限）。
- 新增 `templates/research-report/` 及其加载器集成测试（双校验全绿 + 快照内联）。
- 不触碰 team_* 工具面、Gate 安全模型、目录协议与 CI/workflow。

## 回滚方式

`.min(1)` 收回 `.min(2)` 即恢复旧口径；research-report 模板为纯增量文件，
可整目录删除。已按单层结构实例化的数据不受影响（实例快照自包含）。
