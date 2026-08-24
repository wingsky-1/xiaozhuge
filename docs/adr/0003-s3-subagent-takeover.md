# ADR 0003: S3 spike 判定报告 —— 跨代 subagent 接管

- 状态：Accepted
- 日期：2026-08-24
- 对应 issue：#4 [MVP][P1] 宿主能力 spike 四连（S3 节）
- 脚本路径：`scripts/spikes/s3-takeover.sh`

## 元信息

| 项 | 值 |
| --- | --- |
| Spike 编号 | S3 |
| 判定 | **No-Go**（触发预注册回退：状态级重建） |
| dsh 版本 | 0.1.1-rc.2 |
| 执行日期 | 2026-08-24 |

## 环境快照

- dsh 版本：0.1.1-rc.2；Node v24.19.0；Linux x86_64。
- 隔离方式：`DSH_HOME=$(mktemp -d /tmp/dsh-spike-s3.XXXXXX)`，仅复制 `settings.yaml`
  与 `.credentials.yaml`。
- 涉及 profile：`headless` ×2（种子会话 + 接管尝试的新根会话）。
- 说明：种子 runner 投递完任务后自然退出，留下孤儿 durable background subagent；
  与 kill 死法在 lineage 校验上等价——校验只比对持久化 `parentSession` 与调用者
  session id（coldResume → authorizeLineage），与父进程死法无关。

## 步骤

1. 种子 headless 会话经 subagent tool 启动一个 `run_in_background` durable 子代理，
   回显其 id 后退出。
2. 裸读子会话日志首行，核对血缘头。
3. 全新 headless 会话对该 childId 调 `send_message` 并调 `list_agents`。
4. 抽查状态级重建数据面：新根可直接读取子会话日志。

## 原始输出

```
lineage header OK: {'id': '<childId>', 'parentSession': 'session-…', 'origin': 'subagent', 'delegationDepth': 1}
takeover-error: [{"type": "tool-result", …, "content": [{"type": "text",
  "text": "Error: subagent \"<childId>\" belongs to another parent session"}],
  "isError": true}]
list_agents-empty: True        # 新根视角 (no subagents)
child log events readable: 24  # 状态级重建数据面可读
```

## 判定

对照预注册判据：

- **Go（可接管）→ 不满足**。新根对旧 durable subagent 的 `send_message` 被
  lineage 校验拒绝，精确错误为
  `Error: subagent "<id>" belongs to another parent session`；`list_agents`
  对旧 child 不可见（按 parentSession 过滤，返回空而非报错）；`interrupt_agent`
  对冷目标为无害 no-op。
- **No-Go 回退（预期概率高）→ 触发**：放弃进程级接管，降级「状态级重建」。
  数据面已验证完备：子会话日志（血缘头 + descriptor + 全部对话与产出）落盘于
  `$DSH_HOME/sessions/<projectKey>/<sessionId>/session.jsonl.zstd`，存储 seam
  不做 lineage 授权，新根可直接读取并对账。P4 验收随之改为「续跑完成同一任务
  且无重复劳动」。

### 对 P4/P5 的设计约束（回退落地）

1. 团队运行态目录协议须把「角色注册表 + 各 agent 最新产出位置」落在 TEAM_HOME
   持久文件中（框架自维护，不依赖 dsh 进程内注册表）。
2. 巡场接管 = 新根读 TEAM_HOME 对账 → 重新 spawn 全套角色 → 注入各自上下文摘要；
   原 durable subagent 会话仅作只读档案。
3. 「同 session id resume 旧根」是一条合法的中间路径（web 重开会话即此），
   但依赖人工持有原 session id，不作为框架主路径。

## 回退触发条件

- 已触发预注册回退（见上）；后续 dsh 若引入显式跨代授权协议（源码注释所称
  "explicit authority protocol"），重跑本脚本复评。
