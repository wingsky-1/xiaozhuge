# ADR 0003: D20 修订 —— Gate 展示为 Console 直读 `gates/*.json`，原生 todo 无投影职责

- 状态：Accepted（Supersedes v2.2 定案 D20）
- 日期：2026-08-25
- 对应 issue：#3 [decision] Gate 待办展示路径修订（正文方案已被评论区终稿推翻，本 ADR 以最新评论口径为准）

## 背景

v2.2 定案 D20：「Gate 待办走 dsh 原生 todo/任务能力 web 展示，宿主端写入」。

实证核查本机 dsh 0.1.1-rc.2 的 `dsh-tool-todo` 发布产物：todo 列表为
**single owner per agent session**，明确 no subagent/shared/swarm scope，
**非 agent 调用者（无 exec.agent）没有写入口且被拒绝**——宿主端插件根本无法
向会话 todo 写入；web UI 渲染的是 agent 自己调 `todo_write` 产生的
`todo/write` 会话事件。原定案按字面实施不可行。

issue 正文随即提出修订方案（Tier-0 自调 `todo_write` 维护含 Gate 待办的清单），
但经对抗性评审发现该「投影双写」存在系统性缺陷：

1. **漂移无告警**：巡场间隙过期窗口、LLM 重写整表的措辞漂移；且 web UI 只渲染
   当前查看会话的事件流，Gate 待办仅在 Tier-0 会话页可见；
2. **整表替换共写风险**：`todo_write` 为全量替换语义，一次截断/幻觉即抹掉
   Gate 项，须引入「保留区 + 稳定 id + 换届重建」一整套补丁；
3. **验收不可证伪**：「下一巡场轮」无时间上界、「可见」无判定主体。

复盘认定：上述补丁全是为「双写」打补丁——**投影关系本身不应存在**。D20 当初
借道原生 todo 只是为省 Console 渲染工作量，而 Console 直读 `gates/*.json`
渲染根本不需要 todo。

## 决策

- **单一事实源**：Gate 审批状态只在 `gates/*.json`；各 agent 任务分解只在各自
  会话的原生 todo。两者无投影关系、无同步义务。
- **Gate 展示**：Console 直读 `gates/*.json` 渲染 pending Gates 区块（只读）；
  Web resolve 落账后状态自然刷新，单一数据通路、零同步逻辑。
- **原生 todo 回归纯粹任务清单用途**：每个 agent 用 dsh 原生 `todo_write`
  维护各自清单（single owner per session 天然语义）；todo 中可出现
  「等 gate:x 批准后继续」类普通工作计划条目，但不承担状态翻转义务，不设
  `gate:<id>` 投影约定、不设保留区规程。
- **不新增 team todo 封装工具**：原生 `todo_write` 已对所有 agent 可调，封装
  无增量价值。
- **Tier-0 巡场规程瘦身**：不含任何 Gate 投影/同步职责。
- **P5 关联验收简化为可证伪形态**：真实会话产生 pending gate → Console 区块
  可见 → 人经 Web 批准 → `gates/*.json` 翻转 approved 且 Console 反映。全程
  无 agent 参与同步，断言仅文件状态与渲染两条。

## 影响面

- v2.2 文档 D20 条目以本 ADR 为增量修订记录，不改冻结版正文。
- 开工前须同步修正的关联条目（届时随对应阶段 issue 细化）：
  - #8 任务「Gate 待办展示按决策 issue B：agent 自调 `todo_write` 维护待办
    清单」→ 改述为「无投影职责」；
  - #9 任务「Gate 展示投影按决策 issue B（agent 自维护 todo，Console 只读）」
    → 改为「Console 直读 gates/*.json 渲染 pending 区块」，验收措辞同步替换；
  - #12 总纲：本决策落地不再依赖巡场轮翻转语义；另见 #2 挂起评论中的串行序调整。

## 回滚方式

纯规程与展示层变更，无协议影响；回滚即恢复 D20 原案（宿主端写入原生 todo），
须先解决 dsh 侧非 agent 调用者无 todo 写入口的前提限制。
