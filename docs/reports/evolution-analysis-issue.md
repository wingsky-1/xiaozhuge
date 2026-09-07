# [分析与演进] 小诸葛（xiaozhuge）项目现状诊断与优化路线图

## 1. 背景与目标

小诸葛（xiaozhuge）起源于 dsh-plugin-hub 的 #171 与 #172，定位为一个基于 DeepSeek Harness (dsh) 的 Agent Team 协作框架。它的核心设计理念是：
- **“协议在框架，知识在配置”**：通过配置 `team.yaml` 和 `roles` 切换场景。
- **“策略在提示词，动作用工具”**：协作动作完全通过 `team_*` 工具强制执行，不依赖 LLM 的“自觉”。
- **单入口与巡场循环**：Tier-0 作为主控，通过 Goal 续轮驱动，人类仅与 Tier-0 和 Gate 进行单点交互。

然而，在实际运行（如 `oss-maintenance` 场景）中，我们观察到效果欠佳，**没有按照预期的多 agent 协作流程运行**。本 Issue 旨在诊断当前运行跑偏的根因，提炼小诸葛相比同类框架的核心优势，并制定下一步的演进与优化方案。

---

## 2. 当前运行偏差的诊断（为什么跑偏？）

基于对架构设计（`10-generic-model.md`, `11-generic-runtime.md`, `tier0-playbook.md`）的分析，目前多 Agent 协作无法预期进行的根本原因主要集中在 **严格的机制约束与 LLM 实际指令遵循能力的错位**：

### 2.1 复杂的框架协议超出了 LLM 的 Context/遵循能力
* **Tier-0 巡场负担过重**：`playbooks/tier0-playbook.md` 中定义了极度严苛且步骤繁琐的循环规程（Startup Reconciliation -> Patrol Loop 包含收割信箱、巡检 Gate、Blocked 追踪、派发、睡眠等）。LLM 很容易在某个微小环节（例如忘记 `parent=<self>` 或错误评估 `status=running`）出错，导致状态机卡死。
* **工具链的硬性断言**：框架设计了极强的校验（例如 `team_*` 工具强制的状态机迁移、互斥组冲突拒绝、dod 回执格式校验等）。只要大模型输出哪怕极其微小的格式错乱，工具即拒绝执行，导致大模型陷入无尽的 `blocked` 状态或尝试无效重试。

### 2.2 缺乏弹性的错误恢复机制 (Fallback)
* 尽管设计了熔断机制（Circuit Breaker，连续 3 轮卡死即熔断交给人），但在实际开发/调试过程中，一旦大模型陷入逻辑死锁（如循环派发自己，或者错误地更新任务状态），框架没有自动的“纠偏”提示。当前更多依赖于熔断后抛给人类，导致“自动化协作”变为了“高频人类干预”。

### 2.3 状态碎片化带来的上下文割裂
* 虽然底层有清晰的 `TEAM_HOME` 目录协议和文件落盘机制，但在每一轮 Prompt 中，Agent 必须通过 `team_inbox`, `team_task_list` 等工具去**自行拼装**全局视野。一旦某个子 Agent 忘记调用或理解错了某个分片（Blackboard），就会出现“自说自话”的幻觉，脱离了团队任务主轴。

---

## 3. 核心优势提炼：小诸葛的“护城河”是什么？

与目前市面上成熟的多 Agent 框架（如 AutoGen, LangGraph, MetaGPT 等）相比，小诸葛并非在做重复造轮子，其最核心的差异化优势在于 **“确定性”** 与 **“安全边界”**：

1. **协作语义的强制工具化 (Deterministic Enforcement)**
   * **对比 MetaGPT/AutoGen**：传统的框架大多依赖 LLM 在 Prompt 中的角色扮演，比如“你现在是评审员，请评审上述代码”。由于没有物理隔离，LLM 极易越权或产生幻觉。
   * **小诸葛优势**：动作完全收敛于 `team_*` 工具面。状态（`running / blocked / done`）和信箱机制在底层由纯库 `src/runtime` 强制保证（例如通过 CAS 锁和 proper-lockfile）。Agent 无法伪造状态，也无法越权修改别人 Blackboad 分片。
2. **状态零污染与强审计性 (Zero-Pollution State Protocol)**
   * **对比 LangGraph**：LangGraph 依赖内存中的 State Graph 传递状态。
   * **小诸葛优势**：提出了严苛的 `TEAM_HOME` 目录协议。所有协作日志（事件流 jsonl、任务账本）完全基于文件并持久化，不污染 Git 工作树。配合 DSH 的机制，其拥有极高的可回放性和审计能力。
3. **基于 DSH Goal 的自驱动巡场 (Watchman Loop)**
   * 框架利用 DSH 的 Goal 机制作为原生驱动力，无需编写额外的 daemon 守护进程。Tier-0 通过“目标未完成自动开新一轮”的方式，实现了低耗的自驱动轮询，这一点在插件生态内是极其轻量且优雅的。

---

## 4. 优化与演进方案：如何让它可用、好用？

为了让上述“护城河”真正转化为优秀的业务表现（如完美运行 oss-maintenance），接下来的演进需要兼顾**降低认知门槛**和**提升可视化体验**。

### 4.1 可用性演进（降低 Agent 犯错率，提高鲁棒性）
* **“瘦身” Tier-0 规程**：将 `tier0-playbook.md` 中过于硬核的底层操作（如游标校验、状态恢复逻辑）部分下沉至 `team_reconcile` 工具内自动完成。Tier-0 的 Prompt 应当更聚焦于“分配谁做什么”，而非“如何操作底层信箱结构”。
* **增加“纠偏助手”钩子 (Auto-Correction)**：在 `team_*` 工具返回错误时（例如违反状态机迁移约束），不仅要返回报错，还要附加一段具体的**补救提示词 (Remediation Prompt)**，直接教 LLM 下一步该怎么调用才能解开死锁，减少无脑重试。
* **组合/复合工具的封装**：例如将原有的（Spawn -> Update Assignee -> Send）直接聚合成一个更高抽象层次的工具，减少事务中间态失败的风险。

### 4.2 易用性演进（降低开发者门槛）
* **提供调试沙盒 (Debug Sandbox)**：在 `templates/` 开发新场景时，提供一种 CLI 模式，允许人类扮演某个 SubAgent 或拦截某个工具调用，从而模拟对话，验证 `team.yaml` 中角色的拓扑结构是否连通。
* **预制件与模板市场**：抽象出更小粒度的 Role 预制件（如：标准的 Reviewer, 标准的 Spec-Writer），让开发者在写新的场景时可以通过一行 ID 引用，无需每次从头撰写包含完整 dod 语义的 prompt。

### 4.3 可视化与体验演进（让黑盒变白盒）
当前主要依赖纯文本渲染，无法直观反映多 Agent 的时序流转。
* **时序与拓扑图 (Visual DAG/Timeline)**：在 `Console` 视图中引入 `@xyflow/react` （目前 package.json 已引入）渲染实时的 Agent 拓扑关系图。节点变色反映真实状态（running/blocked/done）。
* **任务流转白板 (Kanban View)**：基于 `team_task_list` 的状态机，在控制台增加一个只读的 Kanban 视图，用户可以清晰地看到谁在做哪个任务，以及阻塞在哪一个 Gate 上。
* **干预与回溯 (Intervention UI)**：允许用户不仅在 Gate 审批，还能在可视化界面中直接一键“强制熔断当前任务”或“清理无效死锁状态”，这比让人类去打字告诉 Tier-0 更加直观有效。

---

## 5. 下一步行动项 (Action Items)

1. [ ] **Prompt 工程优化**：重构 `playbooks/tier0-playbook.md`，减少对底层文件状态的描述，增强 LLM 易懂的动作指导。
2. [ ] **工具层加固**：在 `handlers.ts` 的报错中加入“下一步纠错建议 (Remediation Text)”。
3. [ ] **UI 建设**：激活 package.json 中的 `@xyflow/react` 依赖，在 `Team Console` 增加拓扑链路图与任务流转看板。
4. [ ] **验收测试**：实跑 `oss-maintenance` 模板，观察 Circuit Breaker 的触发率是否显著下降。
