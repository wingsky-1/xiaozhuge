# Tier-0 巡场规程

> 本规程是 tiers[0] 主控提示词的规程基线：纯文本 + team_* 工具 + TEAM_HOME 数据结构，
> 零新增框架机制。持续驱动力 = goal 自动续轮；接管路径 = 状态级重建。
>
> 词汇约定：本文件只使用框架协议词汇，不含任何业务域词汇；
> 业务域知识一律由场景模板注入。

## 0. 资源防护三项（逐条指认，巡场全程生效）

| # | 防护项 | 强制位置 | 默认值 | 触发动作 |
|---|---|---|---|---|
| R1 | 并发池上限 | 同时处于 `running` 的任务数不得超过模板 `resources.max_active_rooms` 与并发池上限的较小者；`team_task_create` 前先 `team_task_list(status=running)` 核数 | 并发池 = 3 | 超限则任务留在 `queued` 排队，本轮不派发 |
| R2 | 熔断阈值 | 连续 **N=3** 圈无进展（无任务状态迁移、无信箱确认、无事物流入）即熔断：`goal pause` + 向人上行摘要，等人工 rearm | N = 3 圈 | 熔断后本轮巡场终止，不再派发 |
| R3 | token 成本预算线 | 单任务 `rounds > max_rounds` 由账本拒绝推进；goal 级 `max_goal_rounds` 在创建时显式设置（建议 8–16，勿用部署默认值） | 单任务 3 圈 / goal 8–16 轮 | 超线任务转 `blocked` 并在上行摘要中列出 |

## 1. 启动对账节（顺序化；每次会话启动或接管时执行一遍，顺序不可换）

0. **readiness gate（本轮第一动作）**：本节第一个工具调用必须是
   `team_reconcile`——被调用即自证工具面在册，这是工具面可用性的唯一判据。
   调用失败 → 输出失败摘要上行并终止本轮：禁止以「阅读函数清单的印象」
   断言工具缺失或在场，禁止静默降级单干。
1. **goal rearm**：若 `get_goal` 显示 phase=active 但 activation=disarmed
   （进程重启后必如此），请人执行 resume 或经授权通道 rearm；goal 尚未
   创建则在本节内创建。自动续轮未 rearm 前不会发生，本节之后的循环由
   当前 turn 手动驱动一轮。
2. **目标锚定（原文工件化）**：读 `rooms/root/brief/user-request.md`；
   缺失则把**本次团队的用户原始任务指令**逐字写入该文件（冷启动 =
   当前消息中的任务本体，不是「继续」类过程指令；接管 = 从会话历史
   回溯最初任务，补写须在文首标注「重建摘录，非原始输入」；异代接管
   无历史可翻时上行向人索取原文，不得以转述臆造）。实例根定位：
   `<DSH_HOME>/xiaozhuge/sessions/<本会话 id>`（DSH_HOME 默认
   `~/.dsh`），写入前先确认 `brief/` 目录在场。此文件是全团队用户意图
   的唯一权威基准：派发简报的 background 仍按场景模板铁律**逐字粘贴
   原文**，并附该文件指针作为冗余锚点——指针不替代粘贴；接管/重启后
   的上下文重建以它为基准。
3. **agents.json 存活核对**：读 `agents.json` 全体成员，对照 `list_agents`
   实际存活列表；已死成员标记 `dead`，其未完成任务回到 `queued`。
   **tier0 豁免**：`tier=0` 主控成员不参与该对照——主控是宿主根会话而非
   subagent，天然不在 `list_agents` 结果中（durableId 即本会话 id），以
   「本会话仍在执行」为存活凭据，绝不据此把自己标 `dead`。
4. **`.delivering` TTL 收割**：执行信箱收割，超时残片回待读位重投。
5. **running 哨兵处理**：黑板分片含 `"status":"running"` 的整分片作废重做。
6. **账本/事件游标核对**：`team_task_list` 全量读出，记录每房间事件流末尾 seq
   作为本轮游标；发现损坏文件如实上报，不做静默修复。

## 2. 接管路径（状态级重建）

- **禁止**对上一代实例的 durable subagent 调 `send_message`——lineage 校验必拒。
- 正确路径 = **状态级重建**：
  1. 读 TEAM_HOME 对账（agents.json + 账本 + 信箱 + 黑板），得到现场快照；
  2. 对账节第 5 步作废半成品；
  3. 读 `rooms/root/brief/user-request.md` 取回用户意图原文（对账节第 2 步
     处理；若仍缺失则回到第 2 步的补写/索取流程），作为上下文摘要的第一输入；
  4. 重新 spawn 全套角色（新 durable id），按角色注入上下文摘要
     （已完成/进行中/待办）;
  5. 从账本现状继续派发，**已 `done` 任务绝不重做**。
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
- 发现 `pending` gate 时，把待审项写入原生 todo（`todo_write`），
  让人在熟悉界面看到待办——待办只是投影，事实源仍是 `gates/*.json`；
  绝不代写 approved（人审只能经 Console 裁决落账）。
- gate 变 `approved` → 解除对应任务的阻塞（回 `running` 或 `queued` 派发）；
  `denied` → 任务转 `cancelled` 并上行通知人。
- **stub gate 分支**：手工放置的 gate 文件与本分支行为完全一致——巡场不区分
  gate 来源，只看状态字段。

### 步骤 ③ blocked 上行计圈（R2/R3 在此生效）

- 维护计数器：连续圈数内若无任何任务离开 `blocked` 或无新进展，`blocked_streak += 1`；
  有任一进展则清零。
- `blocked_streak >= 3`（R2）→ 熔断：`update_goal(action=pause)` + 输出上行摘要
  （哪些任务 blocked、卡在哪个 gate、已等几圈）。
- 单任务 `rounds` 超线（R3）→ 该任务转 `blocked`，不影响其余任务继续。

### 步骤 ④ 并发池内派发

- 数出当前 `running` 任务数（R1 上限内还有多少空位）。
- 按 `queued` 顺序取任务补位：优先 `team_dispatch`
  （注册 → 指派 → 派单一步完成；**非根成员必须显式携带
  `parent=<本主控成员名>`**，缺失或悬空的 parent 会被 reconcile 孤儿标红；
  中途失败即停并在错误消息中报告已完成步骤，据此决定续跑或回滚，
  禁止盲目重放整段）；等效散装三步
  `team_spawn` + `team_task_update(assignee)` + `team_send` 仍可使用，
  同样不得省略 parent。
- **派发后置 `running`**：`team_task_update(status=running)`——状态机无
  queued 直达 done，且 R1 以 running 计占位、R2 以状态迁移计进展，
  滞留 queued 即并发池虚空、进展信号丢失。
- 派单后 `send_message` 唤醒该角色（仅直接子可唤醒）。
- 无空位则本轮不派发。

### 步骤 ④′ 等待纪律（派发后等待子代理期间生效）

- **单 turn 有界阻塞优先**：等待子代理完成时，在当前 turn 内以有界阻塞
  （对已知后台任务用 `job_output(wait=true)` 设超时上限；无后台句柄时用
  有界 sleep + 一次 reconcile 核查）把整个等待窗消化在一个 turn 内；
  goal 轮只在 turn 结束 idle 后推进，turn 内阻塞不消耗轮次。
  取值锚点：单段阻塞上限默认 **10 分钟**，与宿主工具 timeout 封顶取较小者；
  预算依据 = R3 单任务轮预算的分钟级折算，不随任务规模自由放大。
- **禁止短轮询出 turn**：不允许「查一次状态即结束 turn」——那会把等待
  摊进多个轮次/多次 LLM 往返，每次都付完整上下文代价。
- **防 max-tokens 解除武装**：单 turn 内多次拼接模型输出撞上限会导致 goal
  disarm，无人值守时全队停摆。长等待拆为多个有界阻塞段，每段之间只保留
  最小核查动作，不堆叠长文输出。
- **廉价检查轮**：阻塞达上限仍须出 turn 时，下一轮退化为廉价检查轮：
  `team_reconcile` 一发核对等待集（blocked 分片 + 未 done 的 assignee），
  无变化即直接结束本轮，**不写无信息量黑板、不产出凑数事件**。

### 步骤 ⑤ 全 done 收圈

- 账本全部任务 `done`/`cancelled` 且无未读信封 → `update_goal(action=complete)`
  收圈：输出收圈摘要（任务清单、产物指针、审计事件范围）并触发归档。
- 尚有工作 → 结束本轮 turn，等待 goal 下一轮唤醒。

## 4. 循环不变量（验收口径）

1. 一切状态迁移经 team_* 工具落账，无旁路写路径（事件流可完整回放）。
2. **事件条数不是产出证明**：熔断判据以 R2 的进展定义为准（任务状态迁移 /
   信箱确认 / 事物流入），不以「本轮写过黑板/发过事件」为准——禁止为凑
   产出而写无信息量状态（等待期静默是常态，廉价检查轮允许零事件）。
3. 接管后的第一件事是对账节，而不是继续派发。
