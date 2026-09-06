# ADR 0024: brief 工件化框架落盘与协议偏差机械检测

- 状态：Accepted
- 日期：2026-09-06
- 对应 issue：#212（2026-09-06 release-note 演练复盘 → ADR 0015 确定性下沉收尾）
- 评审留痕：#212 评论（独立子 agent 八维度对抗性评审：需修订后采纳，修订全部并入）

## 背景

2026-09-06 dsh-plugin-hub「准备 release note」演练中，research-report 团队被主控跑成单 agent 会话：零委派、零建账、零派发；brief 锚点文件被主控用通用 write 工具手写相对路径 `rooms/root/brief/user-request.md`，污染 git 工作树，且内容被擅自扩展（verbatim 铁律违背）。

实证修正复盘文档误归因：框架从不读 `TEAM_HOME` 环境变量、实例根恒为 `<DSH_HOME>/xiaozhuge/sessions/<主会话id>`（ADR 0002），污染纯因主控手写相对路径。根因指令 = playbook 现行文案 *"If missing, **write** ... into this file"*（相对路径 + 主控手写），且框架工具面无写 brief 的工具——与操作不变量 1「所有状态变更须经 team_* 工具」自相矛盾。

本 ADR 是 ADR 0015「确定性事实下沉框架层、不靠提示词记性」的收尾：reconcile/dispatch 两个原语落地后，brief 锚定、委派纪律、黑板沉淀仍留在提示词层。业界同款失效有实证（CrewAI #4783 manager 自干零委派）；「机制优于提示词」有成熟先例（MetaGPT 工件框架落盘、CrewAI `output_file`、Claude Code Hooks 确定性拦截）。

## 决策

### 1. brief 工件化：框架落盘替代主控手写（目录协议只增不改）

- init（HTTP 面，`user_prompt` 入参已在）时框架原子写 `<teamHome>/rooms/root/brief/user-request.md`：
  - 内容 = `framework-written` 水印头 + verbatim 原文直通；空输入写占位（与 activation 兜底占位**同一常量** `USER_OBJECTIVE_PLACEHOLDER`，防双事实源漂移）；
  - 64KB 上限，超限截断 + `[truncated]` 标注；write-file-atomic 原子写（新增 `writeTextAtomic`）；
  - 覆盖防御：目标在场且无水印（master 补写/接管形态）不覆盖；有水印或缺失刷新（同会话重入幂等）。
- team.yaml 快照新增 `brief_framework_written: true`（旧快照无字段 = 存量实例）。
- playbook 启动对账第 2 步改为 **verify + read back**：接管/存量补写才允许主控写，且必须用实例根**绝对路径**，禁止相对路径。`PLAYBOOK_SIGNATURES` 特征句（Objective Anchoring）不变，守门自然延续。
- 目录协议：`rooms/root/brief/` 为 root 房间下新增子目录，不新增房间；房间枚举/黑板/游标不受影响（回归测试锁定）。

### 2. 协议偏差机械检测：`team_reconcile` 输出新增 `protocol_health`（report-only，恒在场）

各检测项三态 `available / not-applicable / warning`（沿 `active_mutex_conflicts` 恒在场先例，消费方零条件分支）：

| 检测项 | 确定性口径 |
|---|---|
| `brief` 三态 | `framework_written`（水印在场）/ `master_written`（在场无水印，接管形态）/ `missing`（告警，文案强制绝对路径）；存量实例 → `not-applicable` |
| `delegation` | 事件流 kind 计数：`team/spawn` + `task/create` 均为零且 init 超出宽限窗（10 min）→ `no-delegation` 告警；有 `mailbox/deliver` 而无注册无账本 → `unregistered-dispatch`（半委派形态，独立文案）。goal 活动诚实标注 framework-invisible 盲区 |
| `blackboard-silent` | **前置条件 = 场景模板声明 `blackboard_required_roles`**（机器可读义务声明）；`task/update(status=done)` 回溯 assignee 轨迹，义务角色 0 个 `blackboard/set` → 告警。未声明 = `not-applicable`（ADR 0015 确定性/判断性分离：判断性成分交模板显式声明后成确定性事实） |
| workspace 污染 | **不新增独立检测**：`scope=audit` 派生标注——unregistered_files 命中框架运行时特征（`rooms/root/events.jsonl`、`rooms/root/brief/**`）→ `rooms_pollution_suspected` + 证据路径。项目自带业务 `rooms/`（无 root 特征）不标（反向用例锁定） |

- **首检留痕去重**：warning 首检 append `protocol/deviation` 事件（ADR 0017 串行化写者约定不变），回填 `first_detected_seq`；留痕已在场 → `repeat: true` + detail 带首检指针，不重复 append（告警疲劳防护）。
- **误报率数据沉淀**：deviation 留痕事件即数据载体，复盘可统计误报/漏报——ADR 0015 report-only → 未来硬卡点的渐进桥。
- **性能预算**：事件统计每房间单遍读取（`EventLog.read(1)`，复用 #187 后的读路径），内存 kinds 过滤，不二次 IO。

### 3. 场景层配套（templates 层，守框架层零业务词汇红线）

- `templates/research-report/team.yaml` 声明 `blackboard_required_roles: [researcher, organizer, writer]`（verifier/reviewer 判断型豁免）；oss-maintenance 暂不启用（缺省 = not-applicable，按场景逐步启用）。
- 双模板 master.md 的 brief 文案改为 verify + read back；research-report master.md 新增 **Human Decision Anchors** 节（版本号/发布范围、聚合包收录、对外发布须人审——业务知识只在 templates 层）。
- playbook Step ② 新增通用机制句：场景声明 anchors 时不 autonomous 执行，请求人经 Gate Console 开 gate；任务状态变更镜像 `todo_write`。

## 明确不做

- 硬卡点（无 brief 拒绝 dispatch 等）：违反 ADR 0015 report-only 先行路线，等误报率数据；
- PreToolUse 式事前拦截：dsh 插件面无对应挂点（宿主能力缺失），如需要应向 dsh 上游立项；
- goal 状态读取：宿主 API 不可达（ADR 0015 V1 实证），维持 framework-invisible 占位。

## 后果与边界（诚实声明）

- 冷启动路径（init→brief）根治路径污染与 verbatim 违背；**接管/异代接管场景的 verbatim 补写仍靠提示词**（framework-invisible 边界），残余风险由 audit 污染标注兜底——本期降发生率不根治。
- 检测是事后告警不是事前拦截；单元级 golden 测试防检测器自身退化，不防模型行为漂移。
- 宽限窗（10 min）内零委派不告警——极短会话的零委派漏检是接受代价（防刚建团误报）。
- `send_message` 直发子代理不经框架事件面，半委派检测覆盖 `mailbox/deliver`（team_send）而非宿主直发——盲区如实声明。
