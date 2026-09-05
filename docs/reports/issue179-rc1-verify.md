# dsh 0.1.2-rc.1 适配收尾验证报告（ADR 0001 spike 复跑 + D-1 实机验证）

> 对应 issue：[#179 适配上游 dsh 0.1.2-rc.1](https://github.com/wingsky-1/xiaozhuge/issues/179)
> 执行日期：2026-09-05
> 验证环境：dsh 0.1.2-rc.1（本机安装）；四重隔离（临时 DSH_HOME + `verify_<随机>` profile + 独立端口 + 独立浏览器实例，dsh-verify-isolated skill 流程）
> 证据截图：`docs/reports/rc1-verify-evidence/`（xzg-create-btn.png / xzg-picker.png / xzg-team-tab.png）

## 一、ADR 0001 spike 复跑（S1 tools 注入）

- **判定：Go**（dsh 0.1.2-rc.1 下结论不变，与 ADR 0001 一致）。
- 方法：`scripts/spikes/s1-tools-injection.sh` 原脚本复跑（临时 DSH_HOME + 全新 headless profile + link 最小 echo 插件）。
- 证据：
  - 环境快照：dsh `0.1.2-rc.1`；`DSH_TOOLS_MODE` 未设置 → presentation mode = native（默认）。
  - 形态 A（根会话）：模型成功调用 `team_echo`，返回 marker `XIAOZHUGE_SPIKE_OK` 正确，session log 命中。
  - 形态 B（spawned subagent 会话）：同上，子代理会话成功调用。
- 含义：rc.1 下「工具注册 → 根会话/子代理双形态原生呈现 → 模型可调用」链路完整，xiaozhuge 插件面（host.ts tools.register）的宿主前提成立。
- 注：S2（goal 续轮）/ S3（subagent 接管）机制面无改动（#179 未触碰 goal/lineage 面），且 rc.1 官方发布确认 `send_message` 双向取代 `report`、goal 机制演进——机制级复跑结论沿用 ADR 0005/0006 并参考子代理 A 调研（goal 全家桶/subagent 服务化见 #179 新能力清单，逐项另立 issue）。

## 二、D-1 插槽数据通道迁移实机验证（浏览器）

验证对象：PR #182 合入的客户端迁移（`conversation.input.right` 等插槽 owner(InputZone) 数据面移除后，改走官方 `inject: (sessionId) => props` 通道 + `sessions.list` 快照订阅 + `conversation.input.for(scope).state` 门面读草稿）。

隔离环境：`DSH_HOME=/tmp/dsh-verify-LzSs2u`（临时）、profile `verify_f2259298`、端口 32847、独立浏览器实例（chromium headless shell，独立 user-data-dir）。

### 验证点与结果（全部通过）

| # | 验证点 | 结果 | 证据 |
|---|---|---|---|
| 1 | 新会话（blank）输入框工具行渲染「创建团队」按钮（TeamCreateButton 经 inject 通道拿 sessionId + sessions.list blank 判定） | ✅ | xzg-create-btn.png（按钮 70×26，唯一） |
| 2 | 点击按钮弹出场景浮层（/api/xiaozhuge/team/scenarios 枚举 oss-maintenance / research-report + 提示文案） | ✅ | xzg-picker.png |
| 3 | 受控单选（issue 80/82）：选择后「在本会话创建团队并发送」从不选中禁用 → 启用 | ✅ | — |
| 4 | 建团完整链路：team/create（实例初始化）→ conversation.send 投递 tier0_prompt（会话消息出现 BOOT_MESSAGE_HEAD + 巡场规程全文）→ 草稿清空 | ✅ | — |
| 5 | blank 订阅翻转：建团后「创建团队」按钮自动隐藏（useSyncExternalStore 订阅 sessions.list 生效） | ✅ | — |
| 6 | 团队 tab 探测与注册：TeamViewWatcher 探测 is_team=true → conversation.view 注册「团队」tab（刷新重挂载路径） | ✅ | — |
| 7 | TeamView 渲染：团队 tab 打开显示状态统计（运行中 1 / 阻塞 0 …）+ master 节点 + 只读画布 | ✅ | xzg-team-tab.png |
| 8 | Console 全程无 error / 无 xiaozhuge 相关告警（仅 React Flow 画布容器尺寸 warning，不影响渲染——节点已正常显示） | ✅ | console 捕获 |

### 发现的非阻塞毛边（记录，另议）

**团队 tab 即时性**：建团成功后、**不刷新页面**的情况下，「团队」tab 不会立即出现（TeamViewWatcher 的 useEffect 依赖 `[sessionId]`，建团不改变会话 id → 探测不重跑；刷新/重挂载后正常注册）。属既有行为（迁移前后同逻辑），非 D-1 回归；建议后续 issue 让探测依赖加入「blank 翻转/团队状态」信号（或探测结果加 TTL 重探）。

## 三、局限声明

- 隔离环境不携带真实 LLM 凭证：建团链路验证到「tier0_prompt 投递成功」为止，未验证后续 tier0 实际执行 turn（巡场循环在 #179 无改动面，宿主 goal 续轮已验证于 ADR 0005）。
- 双主题/窄屏未专项验证（D-1 为数据通道迁移，不涉及样式与布局；既有 team-view 双主题逻辑未触碰）。
- 浏览器自动化按 skill 纪律全程轮询等待（无固定 sleep），三张截图已归档。

## 四、结论

- ADR 0001 spike 复跑：**Go**（rc.1 下 tools 注入双形态可用）。
- D-1 迁移实机验证：**8/8 通过**，Console 零错误——适配后客户端在 rc.1 宿主正常运行，建团入口全链路可用。
- 唯一遗留观察项：团队 tab 即时性毛边（非阻塞，记录待议）。