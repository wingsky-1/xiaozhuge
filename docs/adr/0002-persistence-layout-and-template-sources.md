# ADR 0002: 持久化落点与场景模板三级来源

- 状态：Accepted
- 日期：2026-08-24（讨论收敛）/ 2026-08-25（定稿）
- 对应 issue：#13 [decision] 持久化落点与场景模板目录（state/approved）

## 背景

v2.2 设计定稿只约定了 `$TEAM_HOME` 相对路径协议与 Team Template 文件格式
（`team.yaml` + `roles/*.role.yaml` + `prompts/*.md`），两处落点悬空：

1. **持久化数据落在哪**：定稿示例为 `<repo>/../team-home/`，未定死。运行数据
   散落各业务仓库旁不利于统一管理，也无法与 dsh 会话 transcript（事件 schema
   中必填的 `session_id` 关联键）形成稳定对应。
2. **场景模板从哪加载**：模板格式已冻结，但内置模板、用户自定义、项目自定义
   三级来源如何共存无约定。

本 ADR 记录 2026-08-24 三轮讨论收敛的结论；本轮只冻结目录结构，其余留实现
阶段微调。

## 决策

### 主目录命名与形态

- 用户空间主目录：`~/.dsh/xiaozhuge/`（DSH-HOME 下）
- 项目空间主目录：`<repo>/.xiaozhuge/`（点目录惯例）

### 目录结构

```text
~/.dsh/xiaozhuge/                    <repo>/.xiaozhuge/
├── sessions/                        └── templates/
│   └── <主会话id>/                      └── <场景>/
│       ├── team.yaml                       ├── team.yaml
│       ├── agents.json                     ├── roles/*.role.yaml
│       ├── ledger/  rooms/                 └── prompts/*.md
│       ├── mailbox/  gates/
│       └── archive/
└── templates/
    └── <场景>/
        ├── team.yaml
        ├── roles/*.role.yaml
        └── prompts/*.md
```

- 一个主会话 = `sessions/` 下一个文件夹，承载该次团队运行的全部持久化数据；
  主会话 id 即实例根，崩溃恢复可直接借 dsh transcript 回溯；
- 场景预设「一个场景一个目录」，二级结构沿用 v2.2 定稿词汇，不另造新词。

### 同名处理

不做跨级覆盖合并；三级来源（包内置只读 / 用户空间 / 项目空间）各自独立存在，
加载时标记来源即可区分，冲突不静默覆盖。

## 备选方案

| 备选 | 被否理由 |
| --- | --- |
| TEAM_HOME 维持定稿示例 `<repo>/../team-home/` | 运行数据散落各仓库旁，无法统一管理，与会话关联弱 |
| 配置入口命名 `.xiaozhuge-team/` | 「team」是框架能力而非配置域限定词，语义重复且过长 |
| 项目空间同名模板覆盖上级 | 覆盖合并引入隐式行为；标记来源已满足审计需求，保持简单 |
| git config 式三级键级合并 `config.yaml` | 承载什么尚未想清楚，整体出范围，待后续单独立项 |

## 影响面

- **P2a（#5）目录协议**：runtime 纯库仍只认相对路径的 `$TEAM_HOME` 抽象根、
  保持零 harness 依赖不变；「默认解析为 `<DSH_HOME>/xiaozhuge/sessions/<主会话id>`」
  属宿主绑定层规则，不改协议本身。
- **P2b（#6）模板校验 / P6a（#10）oss-maintenance 模板**：模板加载需带来源
  标记；MVP 阶段为 runtime 库函数 + 显式指定场景，向导式选择维持 G2 不变。
- 不触碰 team_* 工具面、Gate 安全模型与 CI/workflow。
- **明确出范围**：`config.yaml`（未定承载内容）、模板内部 schema 细节、加载
  API 具体形态——均实现阶段再议。

## 回滚方式

纯落点约定，尚无代码落地；若后续实证不合适，以增量 ADR 重立口径即可。已按
此结构写入的数据可整目录迁移（结构自包含、路径相对化）。
