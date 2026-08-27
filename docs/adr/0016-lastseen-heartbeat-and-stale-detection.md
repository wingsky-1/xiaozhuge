# ADR 0016: lastSeen 心跳刷新与 stale 检测——工具面白名单心跳 + 对账 stale 标注

- 状态：Accepted
- 日期：2026-08-27
- 对应 issue：#97（lastSeen 心跳刷新 + stale 检测，#86 排期序 7）；#120 Wave 2 第 4 项
- 实施分支：`feat/97-lastseen-stale`
- 评审留痕：#97 终稿设计评论（独立对抗性评审修订）+ #97 Wave 1b 对照裁决评论

## 背景

lastSeen 在 #97 之前只在 init/spawn/dispatch 的 upsert 分支刷新
（`Registry.setStatus` 生产路径零调用点），running 成员干活期间不更新。
`src/runtime/view/overview.ts` 头注释因此明文否决过 lastSeen 陈旧横切：
「协议无心跳间隔定义，任意阈值都会把长任务静默期误标」。

#97 终稿回答三问后解冻：刷值范围（哪些工具算活跃信号）、actor 归属、
stale 阈值的协议定义。本 ADR 记录落地形态与实施期新增裁决。

## 决策

### 1. actor 归属 = 事件流 actor 镜像（账面归属）

凡调用以成员 X 的名义在事件流留下 actor=X 或以 X 为目标发生登记/投递写
副作用，即刷新 X 的 lastSeen；`system` 与无归属不刷。**Wave 1b 落地后的
对照裁决（#97 评论区 Wave 2 准备段）**：caller 权威身份（PR #129，
`resolveTeamHomeForView` 反查注入）已存在且可靠，但 touchMember 归属
**不复用 caller、维持镜像口径不变**；caller 仅承担 forbidden 门：

- 安全面与账面正交：caller 回答「谁有权调用」，镜像回答「这笔写记在谁的
  账上」；
- 视图自洽：若改刷 caller，「主控代管 task_update」会出现事件流
  actor=assignee 而 lastSeen 刷 master 的矛盾画面；
- 最小偏离经评审终稿：白名单七触点归属语义零变更。

### 2. 心跳白名单（宁漏刷不可错刷）

| 工具 | 刷新对象 | 说明 |
|---|---|---|
| team_init / team_spawn / team_dispatch | 登记成员 | 既有 upsertMember 幂等分支，未改 |
| team_ack | member 参数 | ack 是成员自己完成的投递消费 |
| team_inbox（仅 claim 分支） | member 参数 | 认领是投递写副作用；readUnread 纯读不刷 |
| team_task_update | 任务 assignee 字段 | 镜像 `appendEvent(updated.assignee)`；调用者身份不入账 |
| team_send | from 参数 | 发件是最廉价可靠的活性信号，排除会让纯协调型成员误入 stale 名单 |
| team_state_set | role 参数 | 分片自写是成员活性信号 |
| team_handoff | to_role 参数 | 交接目标接管任务，其后续活性从这里起算 |

task_create / task_list / state_get / reconcile 不刷（无明确成员 actor 或纯读）。

### 3. touchMember 写纪律（registry.ts）

- **必须内联 await**、由 handler await 链串行执行：writeJsonAtomic 是整文件
  原子覆盖，裸异步 RMW 会与下一请求交错丢失成员记录（对抗评审硬伤修正①）；
  同进程多实例写者串行化前提见 ADR 0017；
- 成员不存在静默跳过：非登记成员无账可刷，可达性校验由 handler 负责；
- heartbeat 插入点统一在该工具全部业务写成功之后（观测信号排最末），且
  **best-effort 吞错**：lastSeen 是可再生观测信号，刷新失败不得放大为调用
  失败（宁漏刷不错杀主事务；下轮成功调用自愈）。

### 4. STALE_THRESHOLD_MS = 30min（types.ts 协议常量区）

- 锚点：= 3× 投递中收割时限（recovery.ts `DEFAULT_DELIVERING_TTL_MS` =
  10min），匹配冻结版定稿 §11「分钟级续轮节奏、非实时系统」；
- 定义收于 `types.ts` 显式协议常量区（运行时消费）；`protocol.ts` 仅按
  re-export 口径同步引用（文档性单一事实源不变）；
- 配置化等真实场景差异数据产出后以增量 ADR 升级，不在本次范围内。

### 5. reconcile 输出增量（ADR 0015 固定 schema 的增量声明）

`team_reconcile overview` 新增三个 report-only 字段（重算不改账本，
reconcile 自身不 touch 任何成员）：

- `master_idle: boolean`——tier0 主控 lastSeen 超阈即 true（goal pause /
  进程亡即出现；主控不入 stale_members 名册，消除自刷矛盾与全员可调的
  续命放大通道）；
- `stale_members: Array<{member, last_seen_age_ms}>`——status=running 且
  超阈且未被黑板豁免的非主控成员（dead 一律不收录：lost 着色已表达防双计；
  spawned/stopped 非干活中不参与标注）；按 member 字典序稳定排序；
- `awaiting_input: Array<{member, last_seen_age_ms}>`——超阈但该房间黑板
  任一分片 blocked 的成员（等待输入 ≠ 停摆的免责档，避免误标触发误干预）；
- 判定为**严格大于**阈值（恰达阈值仍算新鲜，宁少标勿错标）；时钟回拨致负
  age 天然不超阈，无需特判。

golden 契约面：reconcile 测试默认态断言同步补齐三字段；视图归约
（overview.ts）schema 不变。

## 备选与裁决

- **fire-and-forget 触摸**——否决：整文件原子覆盖下异步 RMW 竞态会丢成员
  记录（硬伤修正①，勿二次引入）；
- **reconcile 自动 touch 补刷**——否决：先刷再算在其唯一生产路径不可达，
  且 reconcile 全员可调构成无限续命放大通道；
- **touch 归属复用 caller.member**——否决：见决策 1；主控代管续命列为已
  接受限制而非缺陷修复；
- **展示层黄色横条标 stale**——否决：blocked 已占用黄色通道，stale 用对账
  输出承载（文字标注不做色条）；
- **跨进程/跨实例 agents.json 并发写仲裁（文件锁）**——暂缓：沿用 registry
  层「调用方持锁再写、本层不做跨进程仲裁」既有串行假设（upsertMember 暴露
  同款窗口早于 #97 存在，非本次新增面）；如需收紧另行立项做 file-lock 增强。

## 已接受限制

1. 主控代管更新（root 代 task_update/handoff）给被代管者续命——账面归属
   天然如此，有事件流审计痕迹可回溯；
2. 主控待命期（等用户输入、goal pause）master_idle 会亮起——这是信号语义
   本身（供人观察决断），误报率随 Wave 3 调参数据修订；
3. 黑板不可读时 blocked 免责索引缺失，对应成员可能落入 stale_members——
   罕见 fs 异常降级路径，report-only 宁缺勿滥不做二次兜底。

## 关联

- ADR 0015（reconcile 与 dispatch 固定 schema——本增量声明的载体）
- ADR 0017（同进程多实例写者串行化——touchMember 内联 await 的前提）
- issue #99（挂起兜底阈值协议在本 ADR 定案后解锁）
