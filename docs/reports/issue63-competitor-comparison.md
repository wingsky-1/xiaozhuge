# 竞品对比与定位盘点：agent team 框架差异点与能力边界

> issue #63 spike 产出。调研方法：8 个对象 README 原文全量抓取（2026-08-26 快照）+
> 并行深读 + web 补充佐证；MetaGPT 与 camel 的部分机制细节（watch 路由、workforce
> 提示词环节等）README 未覆盖，来自其源码结构与社区文档，已逐处标注「源码层」；
> 「小诸葛」一侧以 docs/adr/0001–0013 为事实依据。
> 本报告为定位基线，不构成任何实施决策；机制借鉴项均需走对应 issue 的评审流程。

## 一、元信息

| 项 | 值 |
| --- | --- |
| 对应 issue | #63（来源 #1 灵感池） |
| 对比对象 | ruvnet/ruflo、bytedance/deer-flow、Yeachan-Heo/oh-my-claudecode、OthmanAdi/planning-with-files、camel-ai/camel、camel-ai/owl、FoundationAgents/MetaGPT、666ghj/mirofish |
| 对比维度 | 编排模型 / 任务收敛模型 / 记忆与经验 / 工具面与协议 / 安全模型 / 场景化与模板 / 宿主耦合 |

## 二、对比矩阵

| 框架 | 编排模型 | 收敛模型 | 记忆/经验 | 工具面协议 | 安全模型 | 场景化模板 | 宿主耦合 |
|---|---|---|---|---|---|---|---|
| **ruflo** | Queen 分层 swarm + mesh/adaptive，hooks 事件驱动隐性编排，GOAP A* 目标分解 | 混合：GOAP 收敛 + autopilot/loop-workers 常驻值守并存 | **最强**：ReasoningBank+轨迹学习+向量库+跨会话恢复 | 数百 MCP 工具（README 口径 314/~210 不一）+联邦 wss 通道 | 注入拦截/PII 门控；联邦层自述无需人工介入（信任自动降级），产品整体无审批卡点 | 极厚：35 个业务域插件直接内置 | 寄生 Claude Code + 自有 Docker 入口双轨 |
| **deer-flow** | LangGraph 中心主控，`task` 工具运行时 spawn 子 agent | goal 驱动有终点：evaluator 评估 + hidden continuation（上限 8，另有 checkpoint 持久化等前提）+ no-progress 防护 | 强：DeerMem 多后端可插拔（默认本地 SQLite FTS5/BM25，可选 mem0），confidence 驱动淘汰 | MCP 为核心扩展协议，SkillScan 扫描器 | 部署层安全+可选 RBAC 双层过滤+人工审核环节 | Skill 体系：`.md` 定义，渐进式加载+显式激活 | 独立运行时（强依赖 LangGraph） |
| **oh-my-claudecode** | Team-first 五阶段流水线 + Autopilot/Ralph 多轨并存 | verify/fix 循环至测试构建通过 | 强：`/skillify` 自动抽取经验成 skill 文件 + triggers 自动注入 + 会话持久化 | 依赖 Claude Code 插件机制，tmux 启外部 CLI worker | **近乎空白**：无输入过滤、无卡点、无审核 | 19 个 agent 模板 + workflow 命名模板 + 项目/用户双层配置（`.claude/omc.jsonc` / `~/.config/claude-omc/`） | 深度寄生 Claude Code |
| **planning-with-files** | 非编排框架：单 agent + 文件方法论，宿主 hooks 每轮重注入 | **确定性完成闸门**：状态 token + 脚本 grep -F 判定 + GATE_CAP 上限（默认 20） | 文件=磁盘：三文件计划/findings/progress，崩溃恢复组合拳 | 约 12 个 shell 脚本 + 13 个斜杠命令，纯 Markdown 协议 | 浅层：继承宿主，attestation 锁计划防篡改 | templates/ 初始模板 + 5 语言变体，社区 fork 活跃 | 三层分发寄生 60+ 宿主 |
| **camel** | RolePlaying 双角色对话 + workforce 任务树分解（源码层：四段提示词收敛回路） | 轮次/token/重复容忍多路终结 + 独立 Critic 审校回路（cookbook 层面） | 分层记忆 + 向量/BM25 检索 + workflow 经验跨 run 复用 | 40+ toolkit，原生 MCP 支持 | human-in-the-loop 工具审批可选，默认弱 | PersonaHub 角色库 + cookbooks 场景沉淀 | Python 库，模型可插拔 |
| **owl** | 复用 camel society（construct/run 双函数），编排极浅（README 未述任务树分工） | 一轮对话收束终答，靠模型自觉 | 继承 camel stateful memory | 最强工具面：多搜索引擎+浏览器自动化+文档解析，MCP 层 | 默认 subprocess 沙箱，无强制审批 | examples 脚本即模板 | 强耦合 CAMEL 生态 |
| **MetaGPT** | Team→Environment→Role 三层，watch 订阅消息路由 pub/sub（源码层） | 固定轮次+全员 idle+预算耗尽三重终止，粗糙（源码层） | Memory 消息列表追加，无压缩/遗忘策略（源码层） | ToolRegistry 转 OpenAI schema（源码层） | README 无安全章节；源码层仅内容审核 API + 预算控制 | SOP 显式第一概念，角色继承定制 | Python 包 + CLI |
| **mirofish** | OASIS 仿真引擎流水线（社会演化，非任务协作） | 无 goal 收敛，固定模拟轮数 | 必配 Zep Cloud 集成 + GraphRAG 图谱构建与时序记忆更新 | REST 三端点，无标准 agent 工具协议 | **无** | 种子材料驱动，无模板体系 | 独立部署 Web 应用 |

## 三、逐对象评述要点

### ruflo — 同类最接近的对照物，也是体量失控的反面教材
寄生 Claude Code 的 meta-harness，100+ 特化 agent、数百个 MCP 工具（README 内口径不一：314 / ~210 并存）、Rust/TS 混编。亮点在机制层：宿主 hooks 事件自动触发路由与后台 worker（无需用户显式指挥）、GOAP 把目标分解为带前置条件的行动计划且失败后从当前状态自适应重规划。但 README 自陈「无需学 314 个工具」本身就是失控自白；autopilot 常驻值守叠加联邦层「信任自动降级、无需人工介入」的设计（产品整体亦无审批卡点），高危场景失控风险显著。

### deer-flow — goal 收敛的同路人，工程化程度最高
LangGraph 中心主控 + 运行时子 agent。其 `/goal <完成条件>` 由独立 evaluator 模型每轮评估，未满足时最多 8 轮隐藏续跑，2 次相同 non-progress 即停——与小诸葛 goal 续轮（ADR 0005）同构，但多了防振荡的显式设计。记忆多后端可插拔、RBAC 可选双层过滤是框架层少见的认真安全投入。短板：全栈单体（Python+Next.js+nginx+Docker），部署复杂度高。

### oh-my-claudecode — 团队化思路最近，纪律性最差
五阶段团队流水线（plan→prd→exec→verify→fix）理念与小诸葛同构，`/skillify` 从会话自动抽取可复用模式生成 skill 文件并按 triggers 自动注入后续会话——正是小诸葛 #57/#59 设想的已落地形态。但六套编排模式并存（team/CLI-team/autopilot/execute/ralph/ulw）、拼写各异，用户心智负担重；安全模型近乎空白。

### planning-with-files — 「目录即协议」的独立印证 + 确定性闸门范本
单 agent 方法论而非编排框架，但其机械实现恰好补上竞品普遍缺失的两块：①确定性完成闸门——状态 token 用 `grep -F` 字面匹配判定，「所有完成条件同时成立才放行」+ GATE_CAP(20) 防无限阻塞，完全不依赖 LLM 自评；②并行写守卫——检测「已勾选数下降」即告警，直击多 agent 同写互覆问题。另有 smart 注入（目标+下一步+当前 phase+最后三个决策）控制 KV 成本。基准数据为作者自评。

### camel / owl — 学术范式的两极
camel 的 workforce 任务树收敛回路与小诸葛 goal 收敛高度同构——其四段提示词环节（TASK_DECOMPOSE→ASSIGN_TASK→QUALITY_EVALUATION→FAILURE_ANALYSIS）属源码层实现细节（TaskPromptTemplate），README 未展开但可经源码与 cookbook 证实；独立 Critic 审校回路（cookbook 层面）可作反自批 Gate 的对照样本。owl 是 camel 的任务自动化外壳，编排极浅（README 仅示例 construct_society/run_society 双函数，未述任何任务树分工）、工具面最强（GAIA 开源第一），但收敛完全靠模型自觉。「学习」在模型训练侧（Optimized Workforce Learning）而非框架侧经验复用，与 #60 路线不同。

### MetaGPT — SOP 显式化的先驱，安全与收敛双弱
`Code = SOP(Team)` 将流程提升为第一抽象（README 明言）；watch 订阅 + `send_to` 路由的 pub/sub 解耦、轮次/idle/预算三重终止等细节出自源码层（role.py/schema.py/team.py），README 未覆盖（对照小诸葛信箱三段式）。源码层看，收敛无完成度判定；安全几乎为零（仅内容审核 API 与预算控制），外部消息直接进 memory 可被 LLM 当指令执行——恰是小诸葛输入安全条款重点防御的场景。

### mirofish — 用途正交，仅记忆方案有参考价值
基于 CAMEL OASIS 的群体仿真预测引擎（舆情推演、小说结局推演），agent 是「社会演化」而非目标协作，无收敛、无安全、紧耦合云服务。对小诸葛唯一有意义的参照是其 GraphRAG 图谱记忆 + 必配 Zep Cloud 集成（README 未明述 Zep 承担长期记忆职能，「结构化记忆」系合理推断）与 ReportAgent 式收圈后复盘交互。

## 四、差异化定位结论

### 4.1 五条假设的核验结果

| 假设 | 结论 | 证据 |
|---|---|---|
| 1. 寄生宿主 vs 自建运行时是根本区别 | **成立**，且寄生路线已被三方印证（ruflo、oh-my-claudecode、planning-with-files），非孤例冒险 | 三者均深度绑定 Claude Code；小诸葛寄生 dsh 但协作语义层（信箱/黑板/CAS/账本）全部自有，协议化程度为同类最高 |
| 2. 目录即协议获得独立印证 | **成立** | planning-with-files 以纯 Markdown 三文件 + 脚本面实现同类思想并分发到 60+ 宿主，验证了文件协议的跨宿主生命力；其并行写守卫同时暴露了该路线必须补的短板 |
| 3. 安全为一等公民是独特点 | **成立，且是最锐利的差异化** | 8 对象中仅 deer-flow 有可选 RBAC+人工审核；ruflo 联邦层自述无需人工介入且产品无审批卡点；其余安全空白或近乎空白；反自批 Gate 双通道 + 输入安全条款全覆盖在样本内无同量级对手 |
| 4. 收敛导向排除长驻值守站得住 | **成立** | ruflo 的常驻 autopilot 与无人审批叠加正是失控样本；mirofish 无收敛的社会演化不适合任务协作；deer-flow/oh-my-claudecode 等「正经做事」的框架全部是有终点设计——行业事实站在 non-goals 一边 |
| 5. 知识在配置、策略在提示词 | **成立，但经验沉淀是被拉开的最大差距** | 竞品经验机制普遍已落地（ruflo ReasoningBank、deer-flow DeerMem、oh-my-claudecode skillify、camel workflow memory）；小诸葛对应能力尚在 #57/#59 规划中——这是当前唯一的明显落后项 |

### 4.2 定位陈述草案

> 小诸葛是寄生 dsh 宿主的 goal 收敛导向 agent team 框架：目录即协议（账本/事件流/CAS 锁/信箱/黑板全落文件系统，天然可审计可恢复），安全为一等公民（反自批 Gate 双通道 + 输入安全条款全覆盖 + 红线审批流），知识在配置、策略在提示词、经验走增量沉淀。它不做常驻值守与自由群聊——对标样本证明这两条路要么失控要么无法收敛于任务。

### 4.3 non-goals 校验结论

- **长驻值守排除**：维持。ruflo 提供了反面实证；
- **自由群聊排除**：维持。有价值的协作框架全部围绕结构化任务；
- **业务域词汇不入框架层**：维持且加强。ruflo 内置 35 个业务域插件导致体量失控，反证插件化隔离纪律正确；oh-my-claudecode 六套编排模式并存的碎片化则是第二教训——**工具面与模式数量必须克制统一**；
- 新增一条边界认知：non-goals 排除的是「形态」，不是「能力」——经验沉淀（#59）这类跨会话能力与收敛导向并不冲突，反而是收敛质量的前提。

## 五、可吸取机制清单（按优先级，均已映射去向）

| # | 来源 | 机制 | 建议去向 | 优先级 |
|---|---|---|---|---|
| 1 | oh-my-claudecode | `/skillify` 会话经验自动抽取成 skill 文件 + triggers 匹配注入 | #59 经验沉淀自动化（其已落地形态是最直接的方案参照） | 高 |
| 2 | deer-flow | goal evaluator + no-progress 防护（2 次相同评估即停，防续轮振荡） | #57 收圈回顾 / runtime goal 续轮增强 | 高 |
| 3 | planning-with-files | 确定性完成闸门：状态 token + 脚本字面匹配 + 全条件放行 + CAP 上限 | Gate 语义强化（#53 Gate 能力重设计的输入） | 高 |
| 4 | planning-with-files | 并行写守卫：完成数下降即告警 | 黑板分片 / CAS 锁增强候选 | 中 |
| 5 | camel | workforce 四段收敛提示词（分解→派发→质量评估→失败分析；源码层细节） | #57 收圈回顾提示词条款的结构参照 | 中 |
| 6 | planning-with-files | smart 注入：按需注入（目标+下一步+当前阶段+近期决策）控 KV 成本 | #47 三级加载的回读策略参考 | 中 |
| 7 | ruflo | hooks 事件驱动隐性编排（宿主事件自动触发 worker） | #59 hook 触发绑定点选型参考 | 低 |
| 8 | MetaGPT | watch 订阅标签式消息路由 | 信箱工具面远期演进对照 | 低 |
| 9 | ruflo | GOAP 目标分解 + 失败后从当前状态重规划 | 远期规划层候选，暂不立项 | 低 |

## 六、局限声明与核验记录

- 素材以各仓 README（2026-08-26 快照）为主、web 佐证为辅，未逐仓深读源码；README 存在营销性夸大（尤其 ruflo 自报准确率类数据），矩阵中此类表述已标注或剔除；
- **对抗性核验已做一轮**：关键论断逐条对照 README 原文复核，据此修正了初稿三处实质性出入——①MetaGPT/camel 的部分机制（watch 路由、workforce 提示词环节）系源码层而非 README 内容，已改口径并标注；②ruflo「no human in the loop」原文语境是联邦信任自动降级而非产品级无审批总纲，已收窄表述；③ruflo 工具数 README 内口径不一（314/~210），已改为量级表述；
- planning-with-files 基准数据为作者自评且自我披露局限；mirofish 的「Zep 承担长期记忆」为依赖关系推断，非原文陈述，已标注；
- 「小诸葛」一侧依据 ADR 0001–0013 与 AGENTS.md，未做实跑复核。
