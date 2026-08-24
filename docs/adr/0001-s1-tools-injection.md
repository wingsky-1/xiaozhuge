# ADR 0001: S1 spike 判定报告 —— tools 注入（根会话 + spawned subagent 双形态）

- 状态：Accepted
- 日期：2026-08-24
- 对应 issue：#4 [MVP][P1] 宿主能力 spike 四连（S1 节）
- 脚本路径：`scripts/spikes/s1-tools-injection.sh`（插件材料 `scripts/spikes/s1-team-echo-plugin/`）

## 元信息

| 项 | 值 |
| --- | --- |
| Spike 编号 | S1 |
| 判定 | **Go** |
| dsh 版本 | 0.1.1-rc.2（`dsh --version` 输出） |
| 执行日期 | 2026-08-24 |

## 环境快照

- dsh 版本：0.1.1-rc.2；Node v24.19.0；Linux x86_64。
- 隔离方式：`DSH_HOME=$(mktemp -d /tmp/dsh-spike-s1.XXXXXX)`，仅复制 `settings.yaml`
  与 `.credentials.yaml`（LLM provider 配置与凭证）进隔离 HOME。
- 涉及 profile：`headless`（模板 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless`，
  首次 `dsh plugin add` 自动初始化）。
- composition 内容（`--dump-config` 摘录）：

  ```
  # == @wingsky-1/spike-team-echo
  - id: spike-team-echo
    name: '@wingsky-1/spike-team-echo'
  ```

- tools.mode 取值：composition 中 tools entry 的 config 为
  `mode: !!js process.env.DSH_TOOLS_MODE`；实验环境未设置该变量，
  即 schema 默认值 `native`（`ToolPresentationMode = 'native' | 'code' | 'both'`，
  见 `@deepseek-ai/dsh-tools` 类型定义）。

## 步骤

1. 隔离 HOME 内初始化 headless profile 并以 `link:` 协议安装 spike 插件
   （bundle 声明 `dsh.bundle.patch -> cordis.patch.yml`，insert 一条
   `{id: spike-team-echo, name: '@wingsky-1/spike-team-echo'}`；
   插件 `apply()` 经 `ctx.tools.register()` 全局层注册 `team_echo`）。
2. 记录 composition 与 tools.mode 取值。
3. 形态 A（根会话）：headless 单任务要求模型调用
   `team_echo(message='root-form')` 并回显 marker。
4. 形态 B（spawned subagent 会话）：headless 任务经 subagent tool spawn
   子代理，任务为调用 `team_echo(message='subagent-form')` 并回显 marker。
5. 对两形态分别断言：最终回复含 `XIAOZHUGE_SPIKE_OK`；会话 jsonl 日志中存在
   `name:"team_echo"` 且 message 参数正确的成功调用记录。

## 原始输出

```
== [3] 形态 A：根会话调用
XIAOZHUGE_SPIKE_OK
session-log check: OK (.../session-1b549b96-.../session.jsonl.zstd)
== [4] 形态 B：spawned subagent 会话调用
XIAOZHUGE_SPIKE_OK
session-log check: OK (.../cecb74cf-a3c0-4e1d-8118-9d78d4af97af/session.jsonl.zstd)
== [5] 判定：Go —— 两形态均原生呈现、模型成功调用、返回值正确
```

形态 B 命中的日志属子代理独立会话（目录名非 `session-*` 前缀、含
`subagent/descriptor` 事件），证明调用发生在 spawned subagent 会话内。

## 判定

对照预注册判据逐条核对：

| 判据（原文要点） | 实测 | 结论 |
| --- | --- | --- |
| 两形态中工具均以原生工具呈现 | composition 含 spike 插件 insert；mode=native 下模型直接发起 `team_echo` function call | 符合 |
| 模型可成功调用 | 两形态各一次调用均成功返回（首轮实验中曾出现空参调用导致 lossless 失败，见下「工程注记」） | 符合 |
| 返回值正确 | 回显 echo + marker `XIAOZHUGE_SPIKE_OK`，与会话日志一致 | 符合 |

**结论：S1 = Go**。机制上与源码核验一致：任何 agent（含 subagent）每轮经同一
ToolRuntime 单例的 `wireSchemas(scope)` 收集工具，全局层注册对子代理天然可见
（唯一收窄手段是 spawn 请求显式携带 `toolFilter.allow/deny`，常规 spawn 不带）。

### 工程注记（供 P3 实现避坑）

1. 插件必须声明 `inject = ["tools"]`，否则 cordis 拒绝访问 ctx.tools
   （实证报错 `cannot get property "tools" without inject`）。
2. 裸 ToolDefinition 不做参数校验：模型漏传参数时 execute 收到空对象，
   undefined 字段触发 `INVALID_TOOL_OUTPUT: value is not lossless JSON`，
   模型侧无从纠正。execute 内必须自行校验参数并抛出可读错误。
3. `pnpm add file:` 走内容寻址缓存，源码迭代不刷新；开发期用 `link:` 协议安装。
4. 项目红线要求 `@deepseek-ai/*` 仅 `import type`——工具定义为手写字面量
   （mcp-manager 先例），不用 defineTool 运行时导入。

## 回退触发条件

- No-Go 回退未触发（判据全符合）。
- 失效条件：dsh minor/rc 高于本报告记录版本（0.1.1-rc.2）时，重跑
  `scripts/spikes/s1-tools-injection.sh` 确认后再开工依赖 S1 的阶段（P3）。
