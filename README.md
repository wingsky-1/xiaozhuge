# xiaozhuge（小诸葛）

> **开发中（MVP）**：本项目处于早期开发阶段，API 与文档随时可能大幅变动，暂不发布 npm 包，请勿用于生产。

*Xiaozhuge (Little Zhuge) — a multi-agent team framework for DeepSeek Harness.*

小诸葛是一个基于 [DeepSeek Harness（dsh）](https://github.com/wingsky-1/dsh-plugin-hub) 的
**agent team 协作框架**：一个主控（Tier-0 军师）带领多级子 agent 团队，以结构化协议协作完成
有限任务闭环（如开源仓库的 issue/PR 自治维护）。

设计定稿源自 dsh-plugin-hub 的
[issue #171](https://github.com/wingsky-1/dsh-plugin-hub/issues/171) 与
[PR #172](https://github.com/wingsky-1/dsh-plugin-hub/pull/172)（v2.2）。
三份通用设计文档已迁入本仓 [`docs/agent-team/`](docs/agent-team/)（10 通用模型 / 11 运行时 / 12 Console），
**在本仓库独立演进**；后续所有决策修订以 `docs/adr/` 增量 ADR 承载。

## 核心理念

- **协议在框架，知识在配置**：换场景只换模板与提示词；
- **策略在提示词，动作用工具**：协作动作一律经 `team_*` 原生工具执行，校验与记账由框架强制；
- **巡场循环**：dsh goal 原生驱动 + Tier-0 循环规程，无独立守夜人组件；
- **单入口原则**：人只与 Tier-0 对话 + Gate 待办交互，其余一切只读。

## 状态与里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| A0 | 仓库初始化 + 最小脚手架 + CI | ✅ |
| B-spike | tools 注入 / reattach / goal 续轮 三项 Go/No-Go 验证 | ✅（ADR 0001/0005/0006，凭据 `scripts/spikes/`） |
| B(G0) | runtime 库 + team_* 工具集 + 目录协议 + 巡场规程 | ✅（#22/#23/#25） |
| C(G1) | Console 视图 + Gate 原生 todo + negotiation + 断言族 | 进行中（Gate Console 最小页已交付 #24） |
| D | oss-maintenance 模板实跑接管 dsh-plugin-hub 维护 | 进行中（模板 + 加载器 + 本仓彩排闭环 ✅ #26/#28；hub 实跑 #11 未开始） |

## 决策索引（docs/adr/）

- [ADR 0001](docs/adr/0001-s1-tools-injection.md) — S1 spike：tools 注入判定（根会话 + spawned subagent 双形态）
- [ADR 0002](docs/adr/0002-persistence-layout-and-template-sources.md) — 持久化落点与场景模板三级来源
- [ADR 0003](docs/adr/0003-gate-display-console-reads-gates.md) — D20 修订：Gate 展示为 Console 直读 `gates/*.json`
- [ADR 0004](docs/adr/0004-s4-message-hooks.md) — S4 spike：消息钩子可行性（Gate 对话通道前置）
- [ADR 0005](docs/adr/0005-s2-goal-continuation.md) — S2 spike：goal 续轮语义
- [ADR 0006](docs/adr/0006-s3-subagent-takeover.md) — S3 spike：跨代 subagent 接管
- [ADR 0007](docs/adr/0007-cas-lock-proper-lockfile.md) — CAS 锁切换 proper-lockfile
- [ADR 0008](docs/adr/0008-single-tier-template-and-dynamic-orchestration.md) — 单层模板放宽（tiers 下限 1）与主控动态编排
- [ADR 0009](docs/adr/0009-framework-scenario-layering-and-tier0-assembly.md) — 框架/场景提示词分层与 Tier-0 规程组装（#42）
- [ADR 0010](docs/adr/0010-gate-console-hardening.md) — Gate Console 安全加固与自批风险定性（#2）
- [ADR 0011](docs/adr/0011-team-launch-entry.md) — Team 拉起入口与 team_init 工具面下线（#51）
- [ADR 0012](docs/adr/0012-two-stage-review.md) — oss-maintenance 两阶段核验（规格/成品双任务拆分，#46）
- [ADR 0014](docs/adr/0014-in-session-team-launch.md) — 团队拉起入口收敛进会话输入框（#51 修订）

## 内置模板（templates/）

- `templates/oss-maintenance/` — 开源仓库 issue/PR 自治维护场景（两层主控）
- `templates/research-report/` — 通用资料编写场景：单层主控直调五角色
  （收集 / 验证 / 整理 / 编写 / 复核），主控按任务形态动态编排（ADR 0008）

## 框架规程（playbooks/）

- `playbooks/tier0-playbook.md` — Tier-0 巡场规程唯一事实源：来源仅 builtin
  （不进模板三级体系），由 Team 拉起入口以「规程全文 + 固定分隔符 + 场景段」
  组装为 `tier0_prompt` 返回（ADR 0009）。

## 开发

**提交前必做动作（安装 → lint → typecheck → build → test 的顺序与原因、
常见坑）见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**——尤其注意
`pnpm build` 必须先于 `pnpm test`（测试硬性校验构建产物）。命令速览：

```bash
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm build && pnpm test   # 质量门禁 = 全绿
pnpm cov        # 覆盖率（全局四维 >= 70 + 产出 cobertura 报告）
pnpm cov:patch  # 增量覆盖率门禁：变更行 >= 80%（需 pip install diff-cover）
pnpm mutation   # 变异测试（增量模式，得分基线 70；基线文件 stryker-incremental.json 入库）
```

## `scripts/` 目录速览

- `scripts/check-mutation-baseline.mjs` — mutation 基线新鲜度校验
- `scripts/rename-adr.mjs` — ADR 重编号工具
- `scripts/spikes/` — P1 spike 四连的可复现验证脚本
- `scripts/scenarios/` — 场景化验收脚本

## License

MIT

