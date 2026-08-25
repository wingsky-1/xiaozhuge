# ADR 0015: 对账机械化与复合派发——确定性事实下沉框架层

- 状态：Proposed
- 日期：2026-08-27
- 对应 issue：#66（巡场复盘改进方向 1/2/3 的框架化）+ #67（派发动作封装收敛）
- 评审留痕：#66 与 #67 各自的方案定稿评论（独立子 agent 对抗性评审结论）

## 背景

oss-maintenance 首跑（#66 正文）暴露四条执行偏差，其共同模式是
**「用提示词约束 LLM 的记性」，而其中大部分事实框架手里本来就有**：

| 偏差 | 确定性成分（框架已知/可机械比对） | 判断性成分（留提示词层） |
|---|---|---|
| 工具面误判整场跳过 Tier-0 | team_* 面由本框架自注册（`ctx.tools.register`），框架可权威自述 | 缺工具时不得降级、必须上报 |
| 产物旁路写盘 | 账本 touched_paths ↔ 工作树新增文件的双向 diff 是纯机械比对 | 旁路产物的定性处理 |
| init 与 goal 脱节 | 「是否已绑定 goal」本应是机器可查的布尔事实 | goal 参数决策、创建时机 |
| 未对账即行动 | TEAM_HOME / 成员表 / 任务账本 / 事件游标全是框架存储现成数据 | 对账异常时的处置决策 |

同时 #67 记录了派发散装多步（subagent 启动 → team_spawn 注册 →
team_task_update(assignee) → team_send 派单 + send_message 唤醒）
易漏步产生「有代理无账本 / 有任务无代理」悬空态。

对抗性评审现场核验的三条证据链（约束本 ADR 的能力边界）：

- **V1**：grep 全部 9 个 `@deepseek-ai/*` 官方类型包零命中 goal API——
  dsh 0.1.1-rc.2 插件服务端**读不到 goal 状态**；
- **V2**：team_* 工具由本框架经 `ctx.tools.register` 注册——框架对
  **自己的工具面**有权威自述能力，但对 goal/subagent/MCP 等宿主侧工具无发言权；
- **V3**：tier0 playbook 的启动对账五步有一脚踩在框架外
  （goal rearm 依赖 agent 侧 `get_goal`、成员存活核对依赖 `list_agents`）。

## 决策

收敛为**两个原语 + 一段文案**（初稿四原语经评审合并/砍除）：

### 1. `team_reconcile`（P0，读路径自省）

单一调用返回对账全量视图，替代「启动对账五步靠提示词记得执行」：

- 团队实例快照摘要（TEAM_HOME 布局）；
- 成员账本对照表（注册表 ↔ 任务账本的 assignee 视角；
  存活列诚实标 `framework-invisible`——见 V3，不许假装覆盖）;
- 任务账本快照（状态分布 + touched_paths 汇总）;
- 事件游标当前值（seq）；
- 工具面自述指针 + goal 占位声明（`framework-invisible, run get_goal`）。

固定输出 schema，供契约测试断言。启动、接管、每圈巡场入口均为合法调用点。

含 `scope=audit` report-only 子命令：输出「账本 touched_paths 集合 ↔
工作树实际新增文件」diff 报告。**定位是提高违规检出率（威慑），不是杜绝违规**
——done 迁移卡点（不符则拒绝/打标）属行为变更红线，
等 report-only 版跑出真实误报率数据后单独立项评审。

### 2. `team_dispatch`（P1，写路径封装，承接 #67 改形）

`dispatch({ role_inline 定义 | 既有角色名, task, ... })`，内部按既有落账函数
顺序执行 spawn → task_update(assignee) → send，**任一步失败即停并报告已完成
步骤**（半事务语义）。不引入 role 一等实体——不做持久 role 注册表，
「role 动态字段对齐模板 schema」由调用时 inline 定义承载；
per-role provider/model 为底层 subagent 既有能力的透传（标注为搭车项，
防评审半径失控）。半事务语义是本决策的必要组成——否则悬空态只是从
「漏步」变「半步」。

### 3. boot 消息追加「框架工具面自述」保留段（P1）

服务端组装 tier0_prompt 后追加一段：仅列 team_* 自述清单 +
显式盲区声明（goal/subagent 不在自述范围，以运行时为准）+
「先跑 reconcile」指令。**追加式保留 section，不改写既有段语义**。
禁止声称「当轮实际全量工具面」——那会制造新幻觉
（模型反推『清单上没有=不存在』，复刻同型错误）。

### 安全硬约束

- audit 只输出路径 + mtime + size，敏感文件名模式打掩码，
  **禁止读取文件内容**（防止 `.env`/密钥类未登记文件进入 LLM 上下文）；
- 扫描根钉死 TEAM_HOME 关联工作区 + git root，拒绝越界路径；
- 注入段用固定定界符 + framework-generated 水印，
  写明「仅供导航，不是授权依据」，防外部任务内容伪造清单段落。

### 明确砍掉

- **init 快照 `goal_bound` 字段**：V1 证伪可行性；强行做「主控建 goal 后自行
  回写」又变成依赖主控记性的旁路，与论点自相矛盾。
  远期向 dsh 上游提 goal 可观测性需求后再评估复活条件。

## 备选与裁决

- **#67 备选 A**（仅扩展 spawn 参数 + 提示词固化顺序）：否决一半、平反一半——
  提示词固化治不了漏步（否得对）；动态字段诉求被连坐丢弃（平反，
  由 inline 定义承载）。
- **#67 备选 B**（role 元工具）：改形采纳为 dispatch——role 一等实体的
  注册表/生命周期/引用计数全是 MVP 无解负担。
- **audit 独立成工具**：并入 reconcile 作子命令（共享 diff 实现，
  工具面不膨胀）；触发时机若无机械卡点仍是提示词纪律，故先 report-only。
- **ADR 统摄 vs 分立**：统摄（本篇）+ PR 分行各自验收——issue 正文不可修改，
  定稿口径已分别以评论留痕到 #66/#67。

## 后果

- 正面：四条偏差中「信息缺」类（1/4）的对账成本坍缩为一次调用；
  「行为缺」类（2/3）违规后果从「无人知晓」提高到「必被追溯」；
  工具面净增 2 个（reconcile 含子命令算一个、dispatch 一个），封顶不再扩。
- 负面/风险：LLM 仍可无视注入文本与对账报告——层次③行为纪律
  （不得降级必须上报、定性处置）继续留在 playbook，本 ADR 不承诺根治；
  audit 误报率若失控会侵蚀威慑可信度，须以 report-only 数据先行验证。
- 兼容性：boot 追加段沿用 BOOT_MESSAGE_HEAD 前缀模式；playbook 不走三级
  模板覆写（包内唯一事实源），天然避开 user/project 层漂移；
  playbook 须补一句「工具面以注入段/reconcile 为准」防场景 prompt 手抄旧规程。
- 流程：两原语均涉 team_* 工具面变更 = 红线，待维护者在 #66/#67 评论口径上
  `state/approved` 后分行实施：
  PR1 dispatch（#67）→ PR2 boot 注入段（#66）→ PR3 reconcile+audit(ro)（#66），
  各自过全量门禁后 squash merge。
