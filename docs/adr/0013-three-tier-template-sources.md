# ADR 0013: 模板三级来源体系：project 层落点与只读加载解析

- 状态：Accepted
- 日期：2026-08-26
- 对应 issue：#47 [MVP] 模板来源体系演进：project 层落点 .dsh/xiaozhuge/ 与加载入口（v2 提案获批，
  `state/approved` 已打）

## 背景

#51（Team 拉起入口）已为 builtin 白名单实现了场景选择与实例化（`resolveBuiltinScenarioDir`、
`listBuiltinScenarios`）。但用户与项目空间的模板来源一直是空悬的 ADR 0002 定稿，
停留在目录约定层面，无加载器实现。

另外，对抗性评审（#47 评论 2026-08-25T04:15:39Z）揭露了安全缺口：template-loader 对
team.yaml 引用的 prompt 相对路径做 join 无穿越防护，可写层激活后构成「任意文件读取 →
内联进 prompt 外泄」原语。

本 ADR 记录三级来源加载的完整实现口径，对 ADR 0002 的关系声明：落点维持定稿不变，
同名处置细化为「同名不静默覆盖 + 显式消歧」，不违背 0002 原文。属于增量 ADR
（ADR 0002 冻结正文不改）。

## 决策

### 1. 三级只读解析

| 层级 | 目录 | 来源标记 | 说明 |
|------|------|----------|------|
| builtin | `templates/`（包内，PACKAGE_ROOT 下） | `builtin` | 随包分发，只读不写 |
| user | `<DSH_HOME>/xiaozhuge/templates/<scenario>/` | `user` | 用户级自定义（ADR 0002 定稿落点） |
| project | `<repo>/.xiaozhuge/templates/<scenario>/` | `project` | 项目级模板（ADR 0002 定稿落点） |

- 全部实时扫描、无缓存──每次 serve 请求重新枚举文件系统，保证模型加载所见即所得。
- 不提供模板创建/写入的 API 面──用户手动创建或 link 已有模板目录进来。
- 三层目录结构一致（team.yaml + roles/*.role.yaml + prompts/*.md，与 ADR 0002 一致）。

### 2. 同名不遮蔽——显式消歧

枚举（入口场景列表）：
- 同名场景多行并存，各带 source 角标（builtin/user/project），由 UI 下拉/人显式选择。
- 排序：按源顺序 builtin → user → project（固定），同源内名称字典序。

实例化（create 请求）：
- create 请求增加可选 `source` 参数消歧。
- 同名且未指定 source 时拒绝并报稳定错误码 `ambiguous-scenario`，**绝不静默择一**
  （承 ADR 0002「冲突不静默覆盖」）。
- 指定 source 但该层无此场景 → 照常报 `unknown-scenario`。
- 唯一场景（无同名）时 source 可选──不传也能正常创建。

### 3. 安全加固

#### 3.1 场景名白名单正则

三级统一执行 `SCENARIO_PATTERN = /^[a-z0-9-]+$/`（继承自 #51 实现），
阻止路径穿越与特殊字符注入。枚举与解析都过此闸。

#### 3.2 Prompt 路径穿越防护

`loadTemplate` 内读取 prompt 文件时执行两道防线：

1. realpath 收敛：场景目录先 `realpath`（解析 symlink 得到真实路径）。
2. 前缀校验：prompt 相对路径 join 后的 resolved 路径必须落在场景目录 realpath 内
   （`promptReal === scenarioReal || promptReal.startsWith(scenarioReal + sep)`）。

不允许相对路径（如 `../../etc/passwd`）逃逸出场景目录读取任意文件。

#### 3.3 Symlink 策略

- 场景目录本身允许 symlink（用户可 `ln -s` 外部模板目录进来，无需复制）。
- 枚举时以 `readdir` + `lstat` 识别目录/symlink 目录，`existsSync(team.yaml)` 跟 symlink。
- 非目录 symlink 文件（孤立 symlink 指向非目录）不列为场景。
- Prompt 引用的 symlink 路径必须收敛到场景目录 realpath 内，否则拒绝。

### 4. 来源可审计

- 快照 `team.yaml` 的 `source` 字段记录实际加载层（运行时模板已验证携带此标记）。
- 入口列表返回 `{ name, source }` 供 UI 标注。
- `playbooks/tier0-playbook.md` 维持仅 builtin（ADR 0009 再次重申，不入三级体系）。

### 5. 共享模型表态

- `.xiaozhuge/` 与 user 层均为本地配置，MVP 不定义团队分发语义（gitignore 策略交使用方）。
- 文档明示可写层模板（user/project）视为不可信输入——安全加固三件套为此提供
  技术保障，但用户仍应审核模板内容。
- 分发策略（如何共享模板到团队）不在本 issue 承载（#47 维护者裁决）。

## 备选方案

| 备选 | 被否理由 |
|------|----------|
| 同名就近遮蔽（project > user > builtin 静默覆盖） | 违反 ADR 0002「冲突不静默覆盖」冻结口径，属隐性改判 |
| prompt 路径仅做简单 `..` 检查（如 `archive-target-escapes` 同款） | 对 symlink 穿越无效——攻击者可通过 symlink 设链绕过字符检查 |
| 投影层合并（project + user + builtin 三层合并 team.yaml） | 过度设计，增加解析复杂度；MVP 不需要多来源合并 |
| 支持自定义创建（API 写模板） | 维护者裁决：暂不支持，用户可自行 link 进来 |

## 影响面

- **ADR 0002 关系**：落点不变、同名处置细化（从「冲突不静默覆盖」到「同名多行并存 + 显式消歧」），
  属于增量完善，不构成改判。ADR 0002 正文不修改，以本 ADR 为准。
- **template-loader.ts**：新增 `listScenarios`、`resolveScenarioDir`、prompt 路径收敛；
  既有 `resolveBuiltinScenarioDir`/`listBuiltinScenarios` 保留兼容封装。
- **handlers.ts**：`init` 接收 `source` 与 `project_root` 参数，走三级解析。
- **team-launch.ts**：scenarios API 返回形态从 `string[]` 变为 `{name, source}[]`；
  create API 接收 `source`（可选）与 `workspace`（可选，project 层根）。
- **入口页**：场景下拉列表显示 source 角标，创建时传 workspace path 与 source 选择。
- 不触及 team_* 工具面（init 已从工具面下线）、Gate 安全模型、CI/workflow。
- 测试：新增三级枚举、同名不遮蔽、ambiguous-scenario、穿越防护、symlink 设防测试。

## 回滚方式

- 增量提交：代码可回退至 #51 状态的 builtin-only 白名单（`resolveBuiltinScenarioDir` 保留）。
- 目录结构：project 层 `.xiaozhuge/` 为非必需目录，移除后行为降级为 builtin+user 二级。
- ADR 0013 本身为增量记录，撤回不影响既有定稿。