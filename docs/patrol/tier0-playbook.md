# Tier-0 巡场规程（P4，issue #8）

> 本规程是 tiers[0] 主控提示词的规程基线：纯文本 + team_* 工具 + TEAM_HOME 数据结构，
> 零新增框架机制。持续驱动力 = dsh goal 自动续轮（P1/S2 Go）；接管路径按 P1/S3
> No-Go 回退 = 状态级重建。
>
> 词汇约定：本文件只使用框架协议词汇（v2.2 定稿），不含任何业务域词汇；
> 业务域知识一律由模板层（P6a）注入。

## 0. 资源防护三项（逐条指认，巡场全程生效）

| # | 防护项 | 强制位置 | 默认值 | 触发动作 |
|---|---|---|---|---|
| R1 | 并发池上限 | 同时处于 `running` 的任务数不得超过模板 `resources.max_active_rooms` 与并发池上限的较小者；`team_task_create` 前先 `team_task_list(status=running)` 核数 | 并发池 = 3 | 超限则任务留在 `queued` 排队，本轮不派发 |
| R2 | 熔断阈值 | 连续 **N=3** 圈无进展（无任务状态迁移、无信箱确认、无事物流入）即熔断：`goal pause` + 向人上行摘要，等人工 rearm | N = 3 圈 | 熔断后本轮巡场终止，不再派发 |
| R3 | token 成本预算线 | 单任务 `rounds > max_rounds` 由账本拒绝推进（P2a 强制）；goal 级 `max_goal_rounds` 在创建时显式设置（建议 8–16，勿用部署默认 256） | 单任务 3 圈 / goal 8–16 轮 | 超线任务转 `blocked` 并在上行摘要中列出 |

## 1. 启动对账节（顺序化；每次会话启动或接管时执行一遍，顺序不可换）

1. **goal rearm**：若 `get_goal` 显示 phase=active 但 activation=disarmed（进程重启后必如此，
   P1/S2 结论），请人执行 resume 或经授权通道 rearm；自动续轮未 rearm 前不会发生，
   本节之后的循环由当前 turn 手动驱动一轮。
2. **agents.json 存活核对**：读 `agents.json` 全体成员，对照 `list_agents` 实际存活列表；
   已死成员标记 `dead`，其未完成任务回到 `queued`。
3. **`.delivering` TTL 收割**：执行信箱收割原语（P2a recovery），超时残片回待读位重投。
4. **running 哨兵处理**：黑板分片含 `"status":"running"` 的整分片作废重做（P2a recovery）。
5. **账本/事件游标核对**：`team_task_list` 全量读出，记录每房间事件流末尾 seq 作为本轮游标；
   发现损坏文件如实上报，不做静默修复。

## 2. 接管路径（P1/S3 No-Go 回退的唯一落地形态）

- **禁止**对上一代实例的 durable subagent 调 `send_message`——lineage 校验必拒
  （实证错误：`belongs to another parent session`）。
- 正确路径 = **状态级重建**：
  1. 读 TEAM_HOME 对账（agents.json + 账本 + 信箱 + 黑板），得到现场快照；
  2. 对账节第 4 步作废半成品；
  3. 重新 spawn 全套角色（新 durable id），按角色注入上下文摘要（已完成/进行中/待办）;
  4. 从账本现状继续派发，**已 `done` 任务绝不重做**。
- 「同 session id 恢复旧根会话」是合法的便利路径（web 重开会话即是），但它依赖
  人工持有原会话 id，不作为框架主路径。

## 3. 巡场循环（goal 每轮醒来后依序执行）

### 步骤 ① 收割子完成通知 / 读信箱未读

- `team_inbox(member=<自己>)` 读全部待读信封，逐条处理：
  - 子完成通知 → 核对账本任务状态，处理完 `team_ack`；
  - 其他类型按 body.type 分派。
- 处理完的信封立即 ack，防止收割重投造成重复消费。

### 步骤 ② 巡检 gates（含 stub gate 分支）

- 读 `gates/*.json`：凡任务推进被某个 `pending` gate 阻塞 → 该任务转 `blocked`
  （`team_task_update(status=blocked)`），并在等待清单记录 gate id。
- gate 变 `approved` → 解除对应任务的阻塞（回 `running` 或 `queued` 派发）；
  `denied` → 任务转 `cancelled` 并上行通知人。
- **stub gate 分支**：手工放置的 gate 文件与本分支行为完全一致——巡场不区分
  gate 来源，只看状态字段。
- 注意：本步骤只做阻塞判定，不含任何 Gate 待办投影/同步职责（#3 最终决策：
  Console 直读 gates 文件渲染，与原生 todo 完全解耦）。

### 步骤 ③ blocked 上行计圈（R2/R3 在此生效）

- 维护计数器：连续圈数内若无任何任务离开 `blocked` 或无新进展，`blocked_streak += 1`；
  有任一进展则清零。
- `blocked_streak >= 3`（R2）→ 熔断：`update_goal(action=pause)` + 输出上行摘要
  （哪些任务 blocked、卡在哪个 gate、已等几圈）。
- 单任务 `rounds` 超线（R3）→ 该任务转 `blocked`，不影响其余任务继续。

### 步骤 ④ 并发池内派发

- 数出当前 `running` 任务数（R1 上限内还有多少空位）。
- 按 `queued` 顺序取任务补位：`team_task_update(status=running, assignee=<角色>)` +
  `team_send` 派单 + `send_message` 唤醒该角色（仅直接子可唤醒）。
- 无空位则本轮不派发。

### 步骤 ⑤ 全 done 收圈

- 账本全部任务 `done`/`cancelled` 且无未读信封 → `update_goal(action=complete)`
  收圈：输出收圈摘要（任务清单、产物指针、审计事件范围）并触发归档。
- 尚有工作 → 结束本轮 turn，等待 goal 下一轮唤醒。

## 4. 循环不变量（验收口径）

1. 一切状态迁移经 team_* 工具落账，无旁路写路径（事件流可完整回放）。
2. 每轮巡场至少产出一条事件；连续三圈零事件即触发 R2 熔断。
3. 接管后的第一件事是对账节，而不是继续派发。
