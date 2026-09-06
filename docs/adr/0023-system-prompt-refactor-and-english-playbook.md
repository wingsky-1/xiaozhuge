# ADR 0023: 系统提示词下沉、英文规程标准化与用户上下文解耦

- 状态：Accepted
- 日期：2026-09-05
- 对应需求：重新设计创建团队的提示词注入逻辑（除用户输入外全英文、结构解耦下沉 SystemPrompt、内容优化精炼）
- 评审留痕：独立子 agent 对抗性评审（防子代理穿透 V-01、防 I/O 穿透 V-02、DSH 序位 slot 600、Prompt Caching 最优排布）

## 背景

自 ADR 0009 与 ADR 0014 确立以来，小诸葛团队创建流程存在以下历史妥协（技术债）：
1. **结构未解耦**：创建团队时，将用户原始任务（draft）、启动头（`BOOT_MESSAGE_HEAD`）、141 行 Tier-0 巡场规程、场景编排提示词与工具清单全部打包，作为首条普通 User 消息发送到聊天会话（`conversation.send` / `session/prompt`）。前端聊天界面极度臃肿，且系统硬约束（R1-R3 资源限制、状态机迁移等）混在 User 角色中，缺乏 System Prompt 的最高控制权威，多轮后易衰减漂移。
2. **前缀缓存（Prompt Caching）命中率归零**：动态变化的用户输入 `<draft>` 拼在 User 消息最开头，破坏了最长公共前缀连续字节匹配，导致其后数千 Tokens 的静态规程跨会话缓存命中率为 0%。
3. **语言与表达冗余**：全中文叙述充斥行政化措辞（“铁律”、“绝对禁止”等），Token 密度低，单次启动占用 3,000+ Tokens，且不符合主流前沿大模型（DeepSeek-V3/R1、Claude 3.5、GPT-4o）对高密度结构化英文 RFC/Markdown 规范的最佳理解习惯。

## 决策

### 1. 结构深度解耦（系统提示词 vs 用户首轮上下文）

- **系统提示词（System Prompt，常驻宿主层注入）**：
  - 承载全团队通用不变规则与场景编排：
    1. **Role & Identity**：Tier-0 Team Master / Orchestrator。
    2. **Resource & Safety Limits (R1-R3)**：并发池上限、连续 3 圈无进展硬熔断、轮次预算线。
    3. **Operating Protocols**：启动顺序对账节（强制 `team_reconcile` 作为 readiness gate、goal 验证与创建、brief 原文落账、存活核对）、巡场推进循环（inbox 即时 ack、gate 巡检与 todo 投影、计圈防死锁、并发配额派发、turn 内有界等待、全 done 收圈）、崩溃接管与纯状态级重建、运行不变量。
    4. **Framework Tool Manifest**：`team_*` 工具语义说明与宿主能力盲区声明。
    5. **Scenario Master Orchestration**：场景特定主控规则（如 oss-maintenance 的 spec/impl 两阶段流水线与 QA dod 回执核验）。
- **用户首轮上下文（User Turn Context，聊天消息）**：
  - 承载实例级运行时数据与激活触发：
    1. **User Objective**：用户原始需求（draft），**逐字保持原文直通**（中文/英文不变，严禁改写或翻译）；若为空则给出明确的兜底占位说明，防目标幻觉。
    2. **Team Context**：场景模板名、工作区绝对路径、实例备注。
    3. **Activation Directive**：精炼明确的首轮行动指令（启动对账 -> 目标落账 -> 巡场推进）。

### 2. 语言全面英文标准化与精炼（除用户输入外）

- 除用户输入（draft）保持原文外，规程、清单、定界符、场景主控及激活指令全面转换为专业、结构严密的英文 Markdown 规范。
- 采用 RFC 2119 风格（MUST / SHALL / MUST NOT）明确操作语义与状态机转移分支，剔除感性强调口号。
- Token 消耗预计由 ~3,200 Tokens 下降至 ~1,300 Tokens（降幅达 55%~60%），提升推理速度。

### 3. Prompt Caching 最优排布法则

System Prompt 内部严格遵循「**变化频率由低到高**」的静态前缀排布原则：
1. `[Tier-0 Framework Playbook & Operating Lifecycle & Safety Limits]`（全局静态不变基线）
2. `[Framework Tool Manifest & Blindspot Disclaimer]`（全局静态不变基线）
3. `[Scenario Master Orchestration Rule]`（场景特定规则）

跨不同场景的团队会话可共享前两个通用基线块的前缀缓存，同场景会话实现 **100% System Prompt 缓存命中**。

### 4. DSH 宿主层注入机制与安全加固

- 在 `src/plugin/host.ts` 中声明注入 `ctx.systemPrompt`。
- 注册 section 名称 `xiaozhuge-team-orchestrator`，严格使用官方预留序位：`order: ctx.systemPrompt.getSectionOrder("TEAM_POLICY")`（600）。
- **防子代理穿透（V-01）**：`text(context)` 必须严格限定为 Root Master 会话（只检查自身 `resolveTeamHome(sessionId)/team.yaml` 是否存在），**坚决不向子代理（subagent）注入 Master 规程**，彻底规避子代理身份精神分裂。
- **防普通会话 I/O 雪崩（V-02）**：`text(context)` 严禁调用低频视图层的全局扫描 `scanSessions()`，采用极轻量存在性检查与进程内 `Map<sessionId, string>` 缓存。

### 5. 双轨兼容 API 与消除双端漂移

- `POST /api/xiaozhuge/team/create` 返回字段增补：
  - `system_prompt`：组装好的英文系统提示词；
  - `activation_prompt`：服务端装配好的精炼英文激活指令（包含 User Objective）；
  - `tier0_prompt`：保留原全量拼接文本，保持向后兼容。
- 客户端（`src/client/index.tsx`）与独立入口页（`src/plugin/team-launch.ts`）直接投递服务端生成的 `activation_prompt`，消除前端硬编码副本与跨 bundle 漂移。

## 影响与后果

- **积极影响**：
  - 聊天界面极度清爽，只展示用户任务与紧凑的激活卡片；
  - 跨会话前缀缓存命中率由 0% 跃升至接近 100%；
  - 启动阶段 Token 消耗降低约 60%；
  - 系统硬约束常驻 System Prompt，显著提高大模型对规程的遵从度。
- **治理与迁移债务**：
  - 测试用例中的中文特征句（`PLAYBOOK_SIGNATURES`、`BOOT_MESSAGE_HEAD`）需同步迁移至英文对应词句，守门测试机制保持完整。
