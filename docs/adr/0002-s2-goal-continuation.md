# ADR 0002: S2 spike 判定报告 —— goal 续轮语义（长驻形态）

- 状态：Accepted
- 日期：2026-08-24
- 对应 issue：#4 [MVP][P1] 宿主能力 spike 四连（S2 节）
- 脚本路径：`scripts/spikes/s2-goal-continuation.sh`

## 元信息

| 项 | 值 |
| --- | --- |
| Spike 编号 | S2 |
| 判定 | **Go**（限定长驻 web 形态；headless 形态结构性不可用，见「形态边界」） |
| dsh 版本 | 0.1.1-rc.2 |
| 执行日期 | 2026-08-24 |

## 环境快照

- dsh 版本：0.1.1-rc.2；Node v24.19.0；Linux x86_64。
- 隔离方式：`DSH_HOME=$(mktemp -d /tmp/dsh-spike-s2.XXXXXX)`，仅复制 `settings.yaml`
  与 `.credentials.yaml`；workspace 为 `/tmp/dsh-s2-work-*` 临时目录。
- 涉及 profile：`web`（模板 `dsh-base` + `dsh-web-app`），独立端口实例，
  与本机常驻 GUI 实例零接触。
- 驱动方式：HTTP RPC（`POST /api/<method>`，envelope
  `{type:"client-request", rpcId, method, payload}`）——`workspace.create` →
  `session.create(agentPreset:"standard")` → `session.prompt(mode:"queue")`。

## 步骤与原始输出

### 实验 B：多轮自动驱动 + idle→下一轮延迟分布

任务要求 create_goal（4 轮 sleep 后 complete，max 6）。实测时间线
（`goal_round` user/message 与相邻 `turn/end` 时间差即驱动延迟）：

```
idle->next-round deltas(ms): [23, 35, 20, 13]
VERDICT-B: PASS
```

4/4 轮由 goal-round-driver 自动注入 `<goal_round>` 提示词推进，round 4 正常
complete 收尾。多次运行延迟稳定在 **13–43ms**（亚秒级、无平台期），与源码分析一致：
驱动为纯事件触发（agent/status idle 边沿 → followup 入队），无定时器、无可配间隔；
轮间空隙即一次 LLM 请求冷启动 + 会话 flush。

### 实验 D：kill → 重启 → rearm 续跑

1. 第二个 goal（sleep 3 × 20 轮）推进到增量 round 2 注入后立即 SIGTERM 服务进程
   （先经 `/proc/<pid>/environ` 核验属本次实验临时 HOME；kill 后断言端口关闭）。
   日志可见 `turn/end reason=interrupted`。
2. 同 HOME 重启实例，发送 `get_goal` + `update_goal(resume)`。
3. 实测：

```
turn/end turn=8 reason={"kind": "interrupted"}     # kill 打断点
goal/change op=resume phase=active rev=2 roundsStarted=2
>>> goal round 3                                    # 从 roundsStarted+1 恢复
- D: resume 时 durable roundsStarted=2；恢复后首个注入轮=3 -> PASS（从 roundsStarted+1 无缝续跑）
```

durable 状态（phase/revision/roundsStarted）跨进程重启保留于会话日志；
activation 归零（disarmed），须人工 `update_goal(resume)`（或 GUI「恢复目标」/
`goal.resume` RPC）rearm 后自动续轮恢复，且不重复已完成的轮次。

### headless 形态证伪（辅助实验）

`dsh --profile headless "<task>"` 内可成功 `create_goal` 且 armed，但 one-shot
runner 在首个 idle 后立即 flush+exit——日志显示 Round 1 已被驱动器入队成 turn 2
却随进程 disposed（`turn/end reason=aborted/disposed`）。续轮机制本身在 headless
内同样触发，只是 one-shot 生命周期不给它运行机会：巡场必须跑在长驻 surface。

## 判定

对照预注册判据逐条核对：

| 判据（原文要点） | 实测 | 结论 |
| --- | --- | --- |
| 存在可靠续轮路径 | web 长驻形态下多轮全自动驱动至 complete；kill/restart 后 resume 可恢复 | 符合 |
| idle→下一轮节奏与延迟分布有实测数据 | 多次运行 deltas 均在 13–43ms（亚秒级、方差小） | 符合 |
| resume/rearm 操作序列明确 | create_goal=人类直连请求时创建即 armed；session 重启/暂停后 activation 归零，唯一 rearm 路径 = 人工 `update_goal(resume)`；模型在自主轮内不能自授 resume（direct-human 授权门槛） | 符合 |
| 连续空转成本上界可配置且有数字 | `maxGoalRounds` 部署默认 256（GoalService defaultMaxGoalRounds）、create_goal 显式传参覆盖；耗尽自动 block(code:"round-limit")；自报 blocked 有 ≥3 轮门槛；用户插话竞争让位、取消自动 pause、max-tokens 结束 disarm | 符合 |

**结论：S2 = Go**。P4 巡场约束：必须跑在长驻 surface（web profile 会话）；
goal 创建时显式传小的 max_goal_rounds（建议 8–16）压低无人值守空转上界；
中断恢复依赖一次人工 resume 动作（P5 的 Gate/UI 需暴露该操作）。

## 回退触发条件

- No-Go 回退未触发（判据全符合；外部定时唤醒/headless 形态 B 预研不需要）。
- 失效条件：dsh minor/rc 高于记录版本 0.1.1-rc.2 时重跑
  `scripts/spikes/s2-goal-continuation.sh`。
