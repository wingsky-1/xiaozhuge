# oss-maintenance 模板说明与示例

本目录为包内置（builtin）场景模板。格式为完整 YAML 1.2，schema 统一由
`src/runtime/template.ts` 校验器锁定；本文件仅作字段说明与示例，
**不参与加载**（加载器只读 `team.yaml`、`roles/*.role.yaml`、`prompts/*`）。

## team.yaml 字段

```yaml
name: oss-maintenance          # 必填，非空
version: 1                     # 必填，正整数
tiers:                         # 必填，1~3 层（单层见 ADR 0008），id 唯一
  - id: master                 # 层 id（gates.at 引用它）
    prompt: ./prompts/master.md   # 规程文本相对路径（缺失即拒载）
roles:                         # 必填，至少一个；引用 roles/ 下定义
  - spec-writer                # 形态一：字符串引用
  - coder                      # 形态二：覆盖对象 { id/ref, ... }（暂未用到）
comm_mode: auto                # auto | explicit（explicit 需 comm 白名单）
archives:                      # 可选归档落点：file 型 target 相对 TEAM_HOME
  - id: run-log                #   （不得 .. 或 / 开头）；url 型必填 url
    type: file
    target: archive/run-log.md
gates:                         # 可选人审闸门：at 引用存在的 tier id
  - id: plan-approval
    at: master
    on: stage-enter:queued     # 形如 stage-enter:<state>
resources:                     # 可选正整数限额（键名协议内约定）
  max_active_rooms: 3
stages_ext: [deciding, building, review]   # 扩展状态；禁与保留态冲突
```

## Role Spec（roles/*.role.yaml）字段

```yaml
id: qa                         # 必填，实例内唯一
title: 质检裁判                 # 展示名（可选）
prompt: ./prompts/qa.md        # 必填，规程文本相对路径
briefing:                      # 可选简报约束
  format: structured           # structured | freeform
  sections_required:           # background|boundary|acceptance|forbidden
    - acceptance
dod:                           # 建议验收清单（字符串数组）
  - 对每条 dod 给出 pass/fail 回执
max_hops: 3                    # 正整数，缺省 3
as_judge: true                 # 全集必须恰好一个 true
```

## 约束速查

- `dod` 与 `briefing.sections_required 含 acceptance` 至少满足其一；
- `as_judge=true` 的 role 在整个 roles 目录中恰好一个；
- 引用的 prompt 文件必须存在，否则加载即拒；
- 同名模板不跨来源级覆盖（builtin/user/project 仅标记区分，#13 口径）。
