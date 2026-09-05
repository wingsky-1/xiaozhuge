# dsh 0.1.2-rc.1 适配评估与 xiaozhuge 演进路线报告

> 本报告为 2026-09-05 双子代理调研（dsh 0.1.2-rc.1 能力增量 + 实现现状对抗评审）与主控独立核验的
> 综合留档，回答三问：①适配 0.1.2-rc.1 可引入哪些新增能力；②当前实现现状与 agent team 方案是否合理；
> ③后续演进（用户体验 / 多 agent 能力 / 普适性）。实施落地分别跟踪
> [#179 适配上游 dsh 0.1.2-rc.1](https://github.com/wingsky-1/xiaozhuge/issues/179) 与
> [#180 P0 基建洞双修](https://github.com/wingsky-1/xiaozhuge/issues/180)；
> 本文不构成实施决策，新能力引入逐项在对应 issue 内走评审。

## 一、dsh 0.1.2-rc.1 适配评估

### 1.1 适配基线：版本口径三重不一致

| 处 | 现状 | 证据 |
|---|---|---|
| 类型包 pin | `0.1.2-alpha.2`（七个 `@deepseek-ai/*` devDeps） | `package.json:32-38` |
| 实际宿主 | `0.1.2-rc.1`（GitHub Release，2026-09-03） | 本机 dsh 安装 |
| 文档/注释 | 「当前 0.1.1-rc.2」 | `AGENTS.md:33`、`src/plugin/host.ts:6` |

ADR 0001 失效条件「dsh 高于 0.1.1-rc.2 时重跑 spike」已触发未执行。「只 import type」纪律（`host.ts:14-16`）使运行时风险低，风险集中在类型面形状变化——适配必须把 pin 升到 0.1.2-rc.1 并跑全量门禁。

### 1.2 破坏性变化清单（须迁移）

| # | 严重度 | 变化 | 影响与本仓证据 | 迁移方向 |
|---|---|---|---|---|
| D-1 | 高·必改 | `conversation.input.right/left/composer.dock` 插槽 `owner(InputZone)` 移除；rc.1 render slot 传 `{}`（`slots.d.ts` input.right 无 owner、`input.dock` 保留 owner 形成对照；运行时 `lib/client.js` alpha.2:14229 vs rc.1:15642） | `TeamCreateButton`（`index.tsx:247-263` 解构 `session/input` 读 `blank/sessionId/draft`）与 `TeamViewWatcher`（`index.tsx:502`）运行时失效 | 经 `ISessions.list.getSnapshot().byId` 取会话快照（模式已在 `loadScenarios` 使用）；草稿经 `conversation.input.for(scopeCtx)` 门面读；顺手消除 `BOOT_MESSAGE_HEAD` 双副本（`team-launch.ts:43-46` vs `index.tsx:73-75`） |
| D-2 | 中·核验 | `dsh-subagent`：`followup→sendMessage`（双向 adjacent）、`reportFrom/registerContinuableSetup/admitPromptContent` 删除、错误码 `attachment-unsupported→attachment-invalid` | 本仓未直接 import dsh-subagent，影响间接；宿主工具面 `send_message/list_agents/interrupt_agent` 现由 `dsh-tool-subagent-control` 提供 | 核验 rc.1 宿主工具面与巡场规程契约兼容，必要时迁移 |
| D-3 | 低 | `dsh-agent`：`seedLength→isSeeded+inheritedEventCount`、seq 品牌化 | 本仓只用 `agent.id`，无实质影响 | 升级后编译期验证 |

**零破坏已实证**：`dsh-tools`（仅注释差异）、`dsh-client-connection`（无差异）、`dsh-client-ui-slots` 类型（无差异）、`dsh-host-webserver`（WebRoute 面无差异）。

### 1.3 可引入的新增能力（rc.1 官方能力，逐项引入价值与成本）

| 能力 | 官方包 | 对小诸葛的价值 | 成本/风险 |
|---|---|---|---|
| goal 全家桶 | `dsh-goal`/`dsh-goal-round-driver`/`dsh-tool-goal`/`dsh-client-ui-goal` | 巡场循环底座官方化：`pause/resume/block+code`/`maxGoalRounds`/`roundsStarted`，R1/R3 防护从提示词纪律变框架硬约束；`pause` 可挂人审 Gate | 低；`tool-goal` 禁止 subagent create/edit、依赖 sessionProjections 注册表 |
| subagent 发现 API | `dsh-subagent` 服务 | 血缘/活动状态/后代树列举（不加载子 agent），存活核对与反查官方化候选 | 低；与自建 registry 互补 |
| workflow 全家桶 | `dsh-workflow`+`dsh-tool-workflow`+`dsh-client-ui-workflow-run` | 确定性编排（固定 DAG 批处理）与 team 动态控制流互补，边界需写文档 | 低；注意定位边界 |
| approval 体系 | `dsh-user-approval`+`dsh-client-ui-approval`+`dsh-authorization`/`dsh-permission-presets` | Gate 人审通道官方化候选（并行评估再定替换） | 中 |
| skill 全家桶 | `dsh-skill`/`dsh-tool-skill`/`dsh-skill-filesystem`/`dsh-client-ui-skill` | 经验沉淀 #57/#59 官方底座（竞品对比 issue #63 的唯一明显落后项） | 中；需与模板三级源体系衔接 |
| agent-presets | `dsh-agent-presets`/`dsh-client-ui-agent-preset` | 角色分化：成员按 role 组装工具/skill/prompt（subagent 继承父方组装） | 中 |
| jobs 系列 | `dsh-jobs-local` 等 | 长任务后台化（归档/对账类重活） | 低 |
| compaction-tool-result-pruner | 官方裁剪工具 | R3 token 预算官方化，缓解 reconcile 返回体膨胀 | 低 |
| session 系列 | `title-llm`/`projection-cache`/`query-sqlite`/`checkpoint-policy` | 会话摘要/投影缓存/查询子系统官方件 | 中 |
| client-ui 观照 | `trajectory`/`approval`/`subagent`/`goal`/`workflow-run` | Team Console 演进高质量参照 | 只读 |

### 1.4 引入优先级 Top 5

1. **goal 全家桶**（巡场底座，R1/R3 硬约束化，收益/成本比最高）
2. **subagent 新 API 迁移**（D-1/D-2 强制项；顺势接发现 API 优化存活核对）
3. **workflow 全家桶**（互补能力，低风险）
4. **approval 体系**（Gate 人审长期官方化方向，先并行评估）
5. **skill 全家桶**（经验沉淀，补齐最大短板）

## 二、实现现状与 agent team 方案评审

### 2.1 总体结论

方向正确、工程纪律罕见（审计/恢复/人审三支柱落实、golden 调用集/双进程 CAS 契约/契约互锁测试/变异测试基线 70/ADR 增量治理俱有实证）；两个**基建洞**必须先补：**agents.json 写路径无串行化**、**路径参数白名单不统一**；另有三处版本口径不一致的兼容性定时炸弹。

### 2.2 各维度发现摘要（完整证据见子代理评审附录）

- **正确性**：F1-1【高】agents.json RMW 无同进程写链（`registry.ts:35-93`，`room.lock` 前提不成立：仅 init 时 acquire 且从不释放，子代理路径不 acquire）→ 并发写丢成员记录；F1-2【高】路径白名单不一致（create.session 仅查非空 `team-launch.ts:144-146`、gate_id/mailbox to+uuid/blackboard room 均无白名单）→ 任意路径写/读原语；F1-3【中】dispatch 半事务 TOCTOU；F1-4【中】open-gate 无审计事件（ADR 0018 未兑现）+ 事件 session_id 按 actor 聚合才能成链；F1-5【中】reconcile 全量读事件流/账本；F1-7【中】running 哨兵作废无存活前置。
- **宿主耦合**：F2-1【中】冻结稿 `team_negotiate/archive_write/gate_open/resolve` 未实现（实际 12 工具）；F2-2【中】`resources` 上限零运行时消费；F2-3【中】`team_send` 可达性 report-only（#138 过渡档）；F2-4【低】「零运行时第三方依赖」注释与事实不符（依赖 proper-lockfile/write-file-atomic/yaml/zod）。
- **性能**：F3-1【中】HTTP 轮询设计良好但指纹 stat 为同步全输入集遍历（每周期 O(文件数)）；F3-2【中】每工具调用一次全文件 heartbeat 写；F3-3【中】tier0 每轮 token/IO 无硬预算。
- **安全**：F4-1【高】= F1-2；F4-2【中】= F1-4①；F4-3【低】Host 比对可被非浏览器伪造（ADR 0010 已定性，审计字段承担检测）；F4-4【低-中】workspace-audit 掩码只掩文件名；F4-5【低】prompt 注入声明性防线齐全（数据非指令/水印/盲区 + root/member/undefined 身份模型）。
- **可维护性**：F5-1【中】team-view.tsx（1064 行）整体覆盖率豁免；F5-2【中】stale 判定双镜像实现；F5-3【低】5 条 ADR Proposed 悬置与已合入代码并存（0015/0019/0020/0021）；F5-4【低】注释版本口径过期。
- **兼容性**：F6-1【中-高】版本三重不一致 + pin alpha 档（见 1.1）；F6-2【低】client 注入形态稳（官方插槽 + external 契约一致，ADR 0014 弃 DOM 注入正确）。
- **复杂度**：21 条 ADR/CAS/事件流/账本/信箱/黑板均有实证需求支撑（非豪华件）；偏重的是**每个机制的防御层四件套（自愈+降级+负缓存+对账）**叠加，可陆续裁剪。

### 2.3 高风险项 Top 5

1. agents.json 并发 RMW 丢记录（数据完整性）
2. 路径注入白名单不一致（任意路径写/读原语）
3. 版本口径三重不一致 + pin alpha 档（宿主升级即类型面断裂风险）
4. 冻结稿「框架断言」承诺 vs 实现差距（negotiate/archive 缺失、资源边界未强制、可达性 report-only）
5. 事件流/账本无压缩、reconcile 全量读（长会话后每轮巡场成本线性增长）

### 2.4 agent team 方案整体利弊

**优点**：① 审计完整性靠构造（事件=工具副作用、无写工具），纯 prompt 编排给不了；② 恢复确定性（状态全落文件，状态级重建有 ADR 0006 实证），强于裸 subagent 树「父死子散」；③ 人机单入口 + Gate 通道收敛控制面；④ 协议/知识分离兑现（两个异构模板实跑、框架零业务词有守门测试）；⑤ 与宿主互补而非替代（goal 续轮/lineage/todo 单 owner 均实证）。

**缺点**：① 复杂度前置（8.2k 行 + 21 ADR + 5 类存储机制，对两个场景的 MVP 是重装备）；② 信任边界模糊（R1 并发池/熔断判定/wait 纪律在 playbook，11§6 却声称「框架断言」）；③ 框架自身数据面并发正确性弱于宿主（agents.json RMW、dispatch TOCTOU）；④ 事件流无压缩，审计可追溯性随会话时长衰减；⑤ 安全面补丁式拼装；⑥ 流程重，单维护者推进慢。

**替代路线对照**：单 agent 大上下文（无并行/无审计/无投票通道，不适配并行 issue 流水线）；dsh workflow（适合固定 DAG，表达不了交叉协商/阻塞上行/人审 Gate 的动态控制流）；裸 subagent 树（最轻但「父死子活」无解、无账本无审计）。**结论：工具面强协议 + 提示词编排 + 文件系统状态是三者中唯一能同时给「审计+恢复+人审」的组合，选型正确；问题不在选型，而在实现深度（写路径一致性、参数白名单）与承诺边界（断言清单兑现度）。**

### 2.5 优先级建议

- **P0**：agents.json 进程内写链（照抄 event-log.ts:31-43 模式，约 20 行，不上文件锁）；五类入路径参数白名单统一（runtime 集中一处，HTTP 面与工具面共用）；版本对齐（pin 升 0.1.2-rc.1 + 三处口径同步 + ADR 0001 spike 复跑）。
- **P1**：open-gate 补审计事件；reconcile 事件游标尾窗化；dispatch 强制 authz rev 作 expectRev；ADR 0015/0019/0020/0021 状态落定 + 11§6 断言清单分档标注兑现度。
- **P2**：stale 判定抽公共函数；投影缓存合并 + 负缓存裁剪；team-view.tsx 纯函数单测补覆盖；resources 上限实现或降级声明；heartbeat 合并写/批刷。

## 三、演进路线

### 3.1 用户体验（人只与 Tier-0 对话 + Gate 待办交互）

| 演进 | 现状 | 方向 |
|---|---|---|
| Gate 交互 | 独立服务端渲染页 `/xiaozhuge/console`（零构建内联 HTML），与 React TeamView 分离 | 并入 TeamView 抽屉/面板，或采用 rc.1 官方 `dsh-client-ui-approval` 组件；resolve 保持唯一写点 |
| 事件流可视化 | detail 视图白名单投影已有 | 参照官方 `dsh-client-ui-trajectory` 做时间线/轨迹视图，把审计完整性变成可见协作回放 |
| 首轮建团 | 输入框 `input.right` 插槽按钮（受 D-1 影响） | 迁移到 sessions 服务取快照后保持原交互 |
| 会话跳转 | 「返回团队」+成员节点跳转已交付（#163） | 顺官方 `dsh-client-ui-subagent` 补成员在线状态/可中断操作 |
| 移动端 | 断点跟随 + 指数退避已做 | Gate 待办移动端可审批（console 页窄屏未专门适配） |

### 3.2 多 agent 能力

1. **官方 subagent 服务化**：接发现 API（血缘/活动/后代树，不加载）做存活核对；`running` 哨兵作废加「成员 dead 或不在线」前置，消除热重载误删。
2. **角色分化**：`dsh-agent-presets` 让成员按 role 组装差异化工具/skill/prompt（subagent 继承父方组装）。
3. **经验沉淀**：`skill` 全家桶落地 #57/#59——框架层提供 skill 化钩子，模板层产出经验文件。
4. **goal 语义增强**：`pause` 挂人审 Gate、`block+code` 挂阻塞上报，R1/R3 从提示词纪律变框架硬约束。
5. **workflow 互补定位写进文档**：固定 DAG 批处理用官方 workflow；动态控制流（交叉协商/逐任务人审/阻塞上行）用 team 编排。

### 3.3 普适性（换场景只换模板）

1. **模板生态正规化**：三级模板源已定稿（ADR 0002/0013），补分享/导入路径与模板市场雏形；`research-report` 单层形态已验证普适性（ADR 0008）。
2. **形态拓展**：headless 已支持（webServer 缺位自动降级，`host.ts:242-243`）；补 sdk/acp 形态验证与文档。
3. **组件化拆分**：`runtime` 纯库已是零 harness 依赖，演进阶段评估独立发布，让其它宿主复用「目录即协议 + 事件流 + 账本」内核。
4. **业务词汇防线**：维持现纪律，skill/模板新能力沿用「框架只给机制、模板承载知识」。

### 3.4 阶段路线图

- **近期（0.1.2-rc.1 适配单，#179）**：pin 升 rc.1 + 全量门禁；D-1 插槽迁移；D-2 核验；版本口径三处同步；ADR 0001 spike 复跑。
- **中期（本迭代，#180）**：agents.json 写链（P0-1）；五类路径白名单（P0-2）；goal 全家桶接入（R1/R3 硬约束化）；open-gate 审计事件；断言清单分档标注。
- **远期（演进）**：approval 体系替换自建 Gate 通道（并行评估）；skill 经验沉淀 #57/#59；workflow 互补场景模板；runtime 组件化；模板生态与形态拓展。

## 四、落地状态

- [#179 适配上游 dsh 0.1.2-rc.1](https://github.com/wingsky-1/xiaozhuge/issues/179)（type/feature）——破坏面迁移 + 类型面升级 + 新能力引入评估清单
- [#180 P0 基建洞双修](https://github.com/wingsky-1/xiaozhuge/issues/180)（type/bug + zone/red-line）——agents.json 写链 + 五类路径白名单

## 附录：调研方法与源材料

- 子代理 A（dsh 0.1.2-rc.1 能力增量）：对比工作区 `0.1.2-alpha.2` 与宿主安装 `0.1.2-rc.1` 的包清单与类型面（diff 实证），通读 rc.1 新能力包 README/类型导出，对照官方 Release（dsh-v0.1.2-rc.1）、本会话核验 7 个 import 包 `.d.ts` 差异与插槽契约运行时行为。
- 子代理 B（实现现状对抗评审）：全仓只读，覆盖 architecture.md、agent-team 10/11/12、ADR 0001-0021、src/plugin 全部 12 文件、src/runtime kernel/collab/template/view 全部、src/client、playbook、scripts、vitest.config、ci.yml、测试抽样。
- 主控独立核验：`pnpm typecheck`（alpha.2 类型下通过）、7 个 import 包 `.d.ts` diff、`conversation.input.right` 插槽 owner 在 rc.1 `slots.d.ts` 的实证、宿主工具面 `send_message/list_agents/interrupt_agent` 来源核验（rc.1 由 `dsh-tool-subagent-control` 提供）。

### 局限声明

- 子代理 A 三处证据不足已标注：rc.1 安装树缺 `dsh-client-ui-slots` 实体原因（registry 有 rc.1）、D-1 插槽条目数据获取的**运行时实机验证**（类型面已实锤、运行时行为待 rc.1 宿主实测）、官方 Inspector/Web Preview 包定位。
- 子代理 B 未覆盖：tests/ 全量逐例细读、baseline.yml、scripts/scenarios 实测运行；如需可续评。
- 报告正文不引入新决策；一切实施以对应 issue 内方案评审获批后的口径为准。