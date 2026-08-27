# ADR 0018: Gate 双通道裁剪定稿——Web Console 单通道 + 对账引导形态 + open-gate 写路径定位

- 状态：Accepted
- 日期：2026-08-27
- 对应 issue：#86（设计一致性审计偏差高-3 与中-7 的治理闭环）；裁决链：#9（威胁模型）、#2（安全模型澄清）
- 关联：ADR 0004（S4 消息钩子 spike）、ADR 0010（Gate Console 安全加固）、12§3 冻结契约

## 背景

冻结契约 12§3 定义了 Gate 批准入口双通道：

1. Web 批准按钮 → `POST team/gates/:id/resolve` 写 `gates/<id>.json`；
2. 对话 Tier-0 → Tier-0 经 `team_gate_resolve` 工具落账。

实施期该双通道被部分裁剪：通道 2 的 `team_gate_resolve` 工具与对话批准交互
整体未实现，实际落地形态为 Console 直读 `gates/*.json` 渲染 pending 区块 +
Web 端点写翻转；另存在一条冻结契约之外的补充写路径 `POST /api/xiaozhuge/gates`
（open gate，供测试/人工放置）。#86 设计一致性审计将两项列为治理偏差：

- 高-3：对话批准通道裁剪「无 ADR 定稿」，对冻结人机契约的实质修订停留在
  issue #9/#2 评论层；
- 中-7：open-gate 写路径「无留痕依据」。

本 ADR 将散落四处的裁决链（ADR 0004 spike 结论、issue #9 威胁模型、issue #2
安全最小集挂起、P5 开工评论的修正口径）收拢为单一定稿。

## 决策

1. **批准入口收敛为 Web Console 单通道**（POST resolve 写事实源），对话批准
   通道（通道 2 原文）自本期 Gate 语义中移除。S4 spike（ADR 0004）判定的 Go
   部分降级为「对账引导形态」：消息钩子用于观测留痕，不做对话批准——长驻
   web 会话限制与 Tier-0 会话即根会话的现实使真·对话批准收益不抵其注入面
   （issue #2 安全模型挂起的直接动因）。
2. **对账引导成为合规形态**：pending Gate 经 Console 渲染 + 审计事件引导人
   就地裁决；`gates/*.json` 唯一事实源、原生 todo 仅投影、agent 永远不能代写
   approved——这三条不变量原样保持。
3. **open-gate 补充通道正名并收编**：`POST /api/xiaozhuge/gates` 定位为
   Tier-0 工具面之外的人工/测试放置通道（gate-console.ts makeGateRoutes 内
   POST 分支）；其安全性已由 ADR 0010 固化（双头互证 CSRF 纵深 + 全量审计
   事件含 remote_ip/sec_fetch_site），自批风险定性沿用「残余风险接受 + 检测」。
4. **对话批准的后置归宿**：归入 #53（Gate 能力重设计）评估项；若复活，须以
   新最小 issue 重走红线评审（人机契约修订），不得援引本 ADR 直接实施。
   P1/P2 演进项（loopback 管理 token / approve 两阶段确认 / place-gate actor
   标注）随 #53 一并评估。

## 备选与否决

- **补齐通道 2 至冻结原文形态**——否决：威胁模型（issue #2 收口定性）表明
  agent 驱动的授权代理是主要残余威胁，对话批准把「人说同意」与「工具落账」
  之间的距离缩短为零增益的距离；且 tier0 对话会话本身即单通道控制面，
  双通道在现有威胁模型下是纯增量攻击面；
- **移除 open-gate 补充通道**——否决：测试与人工放置存在真实消费方
  （handlers 自注测试、Console 演示数据链路），删除将破坏既有验证链；保留
  成本已被 ADR 0010 安全集覆盖。

## 后果

- 12§3 的通道 2 视为「后置到 #53」而非废止：冻结契约未失效，只是首版交付
  边界收敛——后续复活路径已定义；
- reconcile/console 测试基线不受影响（本 ADR 为纯治理定稿，零代码变更）；
- 审计报告中-7、高-3 两项治理偏差就此闭环。
