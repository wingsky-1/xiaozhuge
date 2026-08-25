# ADR 0009: 框架/场景提示词分层与 Tier-0 规程组装

- 状态：Accepted
- 日期：2026-08-26
- 对应 issue：#42 [root-cause] 框架规程与场景提示词分层 + tier0 上下文组装（state/approved）

## 背景

#38 为解 hub worktree 自包含问题，把《Tier-0 巡场规程》全文复制进
`templates/oss-maintenance/prompts/master.md`——框架协议知识与场景编排知识挤占
`tiers[0].prompt` 同一槽位：oss-maintenance 的主控通篇是规程、本场景的编排知识缺位；
而 #44（ADR 0008）引入 research-report 后其 `tier0_prompt` 缺失全部巡场规程。
每加一个场景要么丢规程、要么再抄一份，双副本无同步机制。

判据：「换个场景还成立吗？」成立 → 框架层（巡场循环 / R1-R3 资源防护 / 启动对账 /
接管路径 / 循环不变量）；不成立 → 场景层（业务编排与领域验收口径）。

红线说明：team_* 工具面返回值增补属公共行为变更，已按流程在 #42 获
`state/approved` 后实施。

## 决策

1. **规程迁入包内 `playbooks/tier0-playbook.md`**（唯一事实源）。来源规则：
   **仅 builtin、不可跨级覆盖**——不进入 ADR 0002 模板三级来源体系，
   避免出现第二套来源语义；文件随包分发，保持 hub worktree 自包含（#11 关切）。
2. **`team_init` 组装返回**：`tier0_prompt = 规程全文 + 固定分隔符 +
   tiers[0].prompt`。分隔符为代码常量
   `TIER0_PLAYBOOK_SEPARATOR`（`"\n\n===== tier0 playbook / scenario prompt boundary =====\n\n"`），
   测试锁定确切格式——成为显式协议而非隐性约定。组装对任意场景成立，
   research-report 实例化后自动获得规程全文（#39 的根因修复）。
3. **输出增补 `playbook_digest`**（规程源文件 sha256 前 16 位）：MVP 仅作审计字段，
   不做运行时校验；实例快照同步记录该字段。
4. **场景模板回归纯场景编排**：重写 oss-maintenance `prompts/master.md`
   （如实声明：#38 前原文件仅为路径引用，无可找回原文，本次为重新创作，靠 PR
   评审把关；输入安全条款逐条保留）。反向守门测试禁止内置模板场景 prompt
   复制规程特征句，防双副本漂移复发。
5. **兼容性（只增不改）**：旧快照无 `playbook_digest` 字段按缺省容忍；
   存量已实例化团队不受影响（快照自包含）；回读方不依赖新字段。

## 备选方案

| 备选 | 被否理由 |
| --- | --- |
| 纯双槽位（分返两字段） | 消费方是 fresh 会话中的主控 LLM，单条组装文本最不易漏读；保留既有 `tier0_prompt` 字段兼容 golden 与文档 |
| B：模板 include 指令 | 路径脆弱、加载器复杂化，MVP 不值 |
| C：双副本 + 守门测试 | 每场景复制一份，漂移窗口仍在，未修根因 |
| D：规程硬编码进 TS | 内容进代码丧失可审阅性 |

## 影响面与残余注入面声明

- `src/runtime/template-loader.ts` 新增 `loadTier0Playbook` / `assembleTier0Prompt` /
  分隔符与落点常量；`src/plugin/handlers.ts` team_init 改组装并增补输出；
  `docs/patrol/tier0-playbook.md` 删除（git 历史即存档，不留第三副本）。
- **注入面**：场景段来自可写层（user/project 来源）、拼于规程之后、分隔符理论可伪造。
  评估结论：低风险——场景模板本就由人审引入（PR/gate），攻击者能改场景模板即已
  获得同等能力；MVP 记录不设防，后续如需可升级 digest 运行时校验。
- 不触碰目录协议其余部分、Gate 安全模型与 CI/workflow。

## 回滚方式

还原 team_init 拼接行为（返回 `tiers[0].prompt` 内联文本）即恢复旧口径；
`playbooks/tier0-playbook.md` 与新测试为纯增量文件，可整体删除；
已按新格式实例化的数据不受影响（存量快照缺省容忍新字段缺失与存在）。
