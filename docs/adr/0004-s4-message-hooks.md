# ADR 0004: S4 spike 判定报告 —— 消息钩子可行性（Gate 对话通道前置）

- 状态：Accepted
- 日期：2026-08-24
- 对应 issue：#4 [MVP][P1] 宿主能力 spike 四连（S4 节）
- 脚本路径：`scripts/spikes/s4-message-hooks.sh`（探针插件 `scripts/spikes/s4-probe-plugin/`）

## 元信息

| 项 | 值 |
| --- | --- |
| Spike 编号 | S4 |
| 判定 | **Go**（附实现期约束，见下） |
| dsh 版本 | 0.1.1-rc.2 |
| 执行日期 | 2026-08-24 |

## 环境快照

- dsh 版本：0.1.1-rc.2；Node v24.19.0；Linux x86_64。
- 隔离方式：`DSH_HOME=$(mktemp -d /tmp/dsh-spike-s4.XXXXXX)`，仅复制 `settings.yaml`
  与 `.credentials.yaml`。
- 涉及 profile：`headless` + 探针插件 bundle（`agent/inbox/inserted` 与
  `session/event` 双打点，记录落 `$DSH_HOME/logs/probe.jsonl`）。

## 步骤与原始输出

1. 隔离 HOME 安装探针插件；跑第一条用户消息。
2. 断言双钩子均捕获同一条 `kind=user` 消息、全文一致、时序正确：

```
dual-hook OK (same-text=True, inbox-first=True)
observed source.kind values: ['agent-instructions', 'plugin', 'user']
```

3. nonce 凭证 PoC：第二条用户消息含 `GATE-NONCE-OK-7F3A`，插件识别后写入
   approved 标记文件并记录 `{action: gate-approved-by-nonce}`：

```
nonce action fired at 1787591834914
```

## 判定

对照预注册判据：

- **Go（以 user-role 消息为人意凭证，实现真·对话批准双通道）→ 成立**：
  - 插件可经 `agent/inbox/inserted`（同步、实时）与 `session/event`（post-commit
    firehose）拿到消息的 role、source 与全文 content block，非投影非摘要；
  - `source.kind` 可区分人意消息（`user`）与系统注入（`plugin` /
    `agent-instructions` / `goal` 等），人意判定字段现成；
  - 「nonce → 放行动作」最小链路实测打通。
- No-Go 回退（对话通道降级为对账引导）未触发。

### 实现期约束（P5 Gate 双通道落地必须吸收）

以下来自源码核验与本实证的边界条件，属实现约束而非判据偏离：

1. **approval/request waterfall 抢占**：cordis waterfall 不调 `next()` 即否决整链；
   官方 GUI 应答器装配在前且挂起不透传——第三方 answerer 必须
   `ctx.on("approval/request", fn, true)` prepend 前插并内部透传，否则永远收不到审批请求。
2. **探测点选位**：nonce 探测必须挂 `agent/inbox/inserted`（同步）；审批等待窗内
   step 卡死，`session/event` 存在监听死区。
3. **headless 边界**：探针运行中观察到 headless 会话注入
   `approval:policy = "Approval prompts are disabled"`——该形态下 approval waterfall
   根本不派发，Gate 对话通道只能在长驻 web 会话实现（与 S2 结论一致）。
4. **安全边界**：nonce 高熵一次性、绑定请求 id，只经 UI/推送渠道展示给人，
   严禁进入模型上下文（防 prompt injection 抢答）；abort 时清 pending 映射；
   `kind:'user'` 是声明性标记，机制防「模型未经人确认自行放行」，不防恶意插件；
   依赖 rc.2 装配序与 veto 语义，须锚定版本并在 CI 加链序回归断言。

## 回退触发条件

- 未触发。失效条件：dsh minor/rc 高于记录版本 0.1.1-rc.2 时重跑
  `scripts/spikes/s4-message-hooks.sh`。
