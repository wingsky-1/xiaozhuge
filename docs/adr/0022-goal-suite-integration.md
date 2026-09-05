# ADR 0022: goal 全家桶接入与巡场规程硬约束化

- 状态：Accepted
- 日期：2026-09-05
- 对应 issue：#191（[feature] goal 全家桶接入：巡场循环 R1/R3 硬约束化，state/approved）
- 评审留痕：#191 方案评审评论（独立子 agent 对抗性评审源码击穿 pause 权限拦截 + 采纳校准建议 + state/approved）

## 背景

dsh 0.1.2-rc.1 正式发布了官方 goal 全家桶（`dsh-goal` / `dsh-goal-round-driver` / `dsh-tool-goal` / `dsh-client-ui-goal`），提供 `create_goal`、`get_goal`、`update_goal` 原生工具面。
此前小诸葛巡场循环（`playbooks/tier0-playbook.md`）将 R1/R2/R3 防护重度寄托于提示词自觉，存在以下脆弱点：
1. R2 熔断使用未标准化的伪指令，缺少框架级终端状态；
2. R3 token 成本仅单任务 rounds 有账本拒，会话级缺乏硬参数化；
3. 人审 Gate 等待期间缺少与会话轮次挂起的联动机制。

## 决策

1. **官方工具契约同构消费**：
   - **`create_goal` 硬参数化**：在建团首轮（Direct Human Turn）由主控显式传入 `max_goal_rounds`（推荐 8–16 轮），不再依赖宿主隐式默认值；
   - **`get_goal` 巡检**：启动对账节与每轮巡场中，通过 `get_goal` 巡检 `phase`、`activation` 以及已消耗轮次与上限比对；
   - **`update_goal(action=complete)` 收圈**：全部任务 `done`/`cancelled` 且信箱清空后，调用官方原生收圈；
   - **`update_goal(action=blocked)` 上报**：不可逆外部致命阻塞或连续 3 圈无进展（R2）时，调用官方原生接口硬上报收官。

2. **宿主权限模型校准（放弃自治轮 pause）**：
   - 经对抗评审查验宿主源码（`dsh-tool-goal/lib/index.js`），宿主对 `pause` 与 `resume` 实施了严格的 `requireDirectHuman` 权限校验（必须满足 `source.kind === "user"`）；
   - 主控在自治续轮中运行（`source.kind === "goal"`），调用 `pause` 会被底层抛出 `GOAL_TOOL_AUTHORITY_REQUIRED` 异常拦截；
   - **裁决**：模型自治轮内严禁调用 `update_goal(pause)`。局部任务卡 Gate 仅更新该任务账本为 `status=blocked`，不挂起全队；全队停滞且达到 R2 阈值（连续 $\ge 3$ 轮无进展）后，调用合法的 `update_goal(action=blocked, blocked_reason=...)` 终结自治，等待人类在主会话交互唤醒。

3. **人审 Gate 与 Console 联动引导**：
   - 保持 ADR 0010 与 ADR 0018 人审唯一控制面（Web Console POST `/api/xiaozhuge/gates/resolve` 为唯一写点）；
   - Console 在用户批准 Gate 成功后，UI 给出高对比度引导提示：“Gate 裁决已写入。若主控处于等待/阻塞状态，请回到主会话聊天窗口发送「已批准，请继续」唤醒主控”。

4. **工具清单隔离铁律**：
   - `tool-goal` 由宿主挂载至 Tier-0 根会话，子代理严禁调用；
   - `src/plugin/tool-manifest.ts`（`TEAM_TOOL_MANIFEST`）保持仅注册 12 个插件内置 `team_*` 工具，goal 能力不混入清单，互锁契约测试保持纯洁。

## 影响与后果

- **积极影响**：R1/R2/R3 防护升级为框架可见的硬约束；消除了自治轮空转浪费 token；消除了对私有 goal 状态机的需求。
- **限制与取舍**：当 goal 处于 blocked 状态后，必须由人类用户在聊天框发送消息（转入直接人交互轮）才能唤醒和 rearm，不会自动静默唤醒（符合安全人审原则）。
