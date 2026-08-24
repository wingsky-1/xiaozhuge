# xiaozhuge（小诸葛）

> **开发中（MVP）**：本项目处于早期开发阶段，API 与文档随时可能大幅变动，暂不发布 npm 包，请勿用于生产。

*Xiaozhuge (Little Zhuge) — a multi-agent team framework for DeepSeek Harness.*

小诸葛是一个基于 [DeepSeek Harness（dsh）](https://github.com/wingsky-1/dsh-plugin-hub) 的
**agent team 协作框架**：一个主控（Tier-0 军师）带领多级子 agent 团队，以结构化协议协作完成
有限任务闭环（如开源仓库的 issue/PR 自治维护）。

设计定稿源自 dsh-plugin-hub 的
[issue #171](https://github.com/wingsky-1/dsh-plugin-hub/issues/171) 与
[PR #172](https://github.com/wingsky-1/dsh-plugin-hub/pull/172)（docs/agent-team，v2.2），
设计文档将在整理后迁移至本仓库 `docs/`。

## 核心理念

- **协议在框架，知识在配置**：换场景只换模板与提示词；
- **策略在提示词，动作用工具**：协作动作一律经 `team_*` 原生工具执行，校验与记账由框架强制；
- **巡场循环**：dsh goal 原生驱动 + Tier-0 循环规程，无独立守夜人组件；
- **单入口原则**：人只与 Tier-0 对话 + Gate 待办交互，其余一切只读。

## 状态与里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| A0 | 仓库初始化 + 最小脚手架 + CI | ✅ |
| B-spike | tools 注入 / reattach / goal 续轮 三项 Go/No-Go 验证 | 进行中 |
| B(G0) | runtime 库 + team_* 工具集 + 目录协议 + 巡场规程 | 未开始 |
| C(G1) | Console 视图 + Gate 原生 todo + negotiation + 断言族 | 未开始 |
| D | oss-maintenance 模板实跑接管 dsh-plugin-hub 维护 | 未开始 |

## 开发

```bash
pnpm install
pnpm build && pnpm test && pnpm lint && pnpm typecheck
```

## License

MIT
