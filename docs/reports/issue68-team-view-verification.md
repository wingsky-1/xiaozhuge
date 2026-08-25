# 团队视图 tab 隔离实例验证报告

> issue #68 实施完毕后的端到端验收产出。方法：独立隔离实例（`DSH_HOME=/tmp/dsh-lab-issue68`，
> `dsh web --host 127.0.0.1 --port 18443 --no-open`）+ 真实浏览器自动化逐条驱动
> issue 正文验收标准；测试数据为手工注入的模拟团队（非 LLM 运行态），归约正确性
> 另由 242 例单测与变异测试兜底。分支 `feat/issue68-team-view-tab` @ d876a7c+，
> 对应 PR #77。

## 一、元信息

| 项 | 值 |
| --- | --- |
| 对应 issue / PR | #68（state/approved）/ #77 |
| 被测构建 | worktree 全量 `pnpm build` 产物（服务端 dist + 客户端 bundle 562,294 bytes），经 profile `file:` 硬链接依赖直接生效 |
| 隔离环境 | 独立 DSH_HOME + 端口 18443，主实例家族零接触；插件经 profile bundles 装载 |
| 浏览器驱动 | Playwright MCP（桌面视口 1440×900）+ Chrome DevTools MCP 设备仿真（375×812 mobile/touch）+ 网络条件注入（Offline/恢复） |
| 模拟团队 | master(T0 running) ← coder/researcher/judge(T1)；黑板分片：master=running、coder=blocked(+ext 活动)、researcher=running；judge 注册态=dead；事件尾部 5 条 |

## 二、验收标准逐条结论

| # | 验收标准（issue 正文） | 结论 | 关键证据 |
|---|---|---|---|
| 1 | 团队会话出现「团队」tab 于「对话、轨迹」之后；非团队会话不出现 | **通过** | 团队会话 tab 栏 = `Chat \| Trajectory \| 团队`；非团队会话 = `Chat \| Trajectory`；双向切换实测（动态 register/dispose 生效）；blank 会话宿主隐藏整个 header chrome（含 Chat/Trajectory），行为一致 |
| 2 | L1 一屏可见全部房间状态，阻塞视觉权重最高（双主题着色一致，辅图标） | **通过** | 图例汇总条完整：`▶运行中2 ⚠阻塞1 ✓已完成0 ■静默0 ×失联1`；fitView 初始适配一屏 4 节点 3 边；暗色切换（body[data-ds-dark-theme] → MutationObserver → colorMode）下阻塞徽标 `rgb(154,103,0)`→`rgb(210,153,34)`，节点保持渲染；每态带几何图标不依赖单一色觉通道 |
| 3 | 点击成员 ≤2 击到达其原生会话回放 | **通过**（含限制） | 第 1 击节点开抽屉、第 2 击「打开该成员的会话回放」按钮可达且可点；假 durableId 触发三级降级链最终 open(parent)=幂等留在原会话，无崩溃无误导航。真实 subagent 跳转需 LLM 运行态，留待复验（见四.1） |
| 4 | 移动端宽度下树/抽屉可用（抽屉降级全屏 sheet） | **通过** | 375×812 视口：抽屉 rect `(0,0,375,812)` 精确全屏 sheet；画布 4 节点保持可见可交互；URL query `?room=root&actor=coder` 同步正常 |
| 5 | 断网优雅降级：保留最后一次快照 + 重试提示，不白屏 | **通过** | Offline 注入后：错误条「刷新失败（展示最后快照）」+「重试」按钮出现；4 节点、抽屉及其内容（"等待 gate 审批: pr-ready"）全部保留；`document.body` 非空（无白屏）；网络恢复后自动重连，错误条自行消失、视图无跳变 |
| 6 | 归约纯函数单测覆盖；门禁全绿 | **通过** | 归约模块行覆盖 100%；全仓 lint/typecheck/build/test(242)/cov 94.16%/cov:patch 97%/mutation 71.97 全绿（基线 70/70/80） |

## 三、补充验证记录

### 服务端路由面（curl 直驱）

- `team/status`：非团队 `is_team:false`、建团后 `is_team:true`；
- `team/create`：**无 Origin 头的 POST 被双头断言拒绝**（403 forbidden）——安全语义未因新路由松动；携带同源 Origin 建团成功（`room.lock` 幂等返回 `reentered`）；
- `team/scenarios`：builtin 枚举正常（oss-maintenance / research-report）；
- `team/overview`：投影与手工数据逐字段一致——blocked 成员带 `ext.current_activity`（"等待 gate 审批: pr-ready"）、dead 成员落 `lost`、researcher 的活动回退到最近事件 type（blackboard/set）、`payload` 不出现在响应中。

### 客户端装配面

- 「创建团队」按钮（conversation.input.right 插槽）在真实宿主渲染出现——既有插件面与新 watcher 条目并存无冲突；
- verify-client 契约：load id = 包名、apply/inject 装配、2 次插槽注册断言通过。

### URL query 生命周期

- 打开抽屉 → `?room=root&actor=<member>` 写入（replaceState，无新增历史项）；
- Esc 关闭 → 参数被清理还原为 `/`；
- 直接以带 `?actor=` 的 URL 进入时抽屉自动恢复（初始恢复路径，代码审查确认 + 单测覆盖归约侧）。

## 四、已知限制与后续改进项

1. **「打开会话」的真实 subagent 跳转未在隔离环境复验**：需要宿主真实 spawn 出的子会话（LLM 运行态）。已验证的是降级链的安全性与可达性；建议维护者在有凭据的环境做一次人工复验。
2. **触控目标偏小**：移动端抽屉关闭按钮实测 23×22 px，略低于 WCAG 2.5.8 的 24×24 最小值。一行样式修正，随下一提交带上。
3. **lastSeen 陈旧横切未实现**：协议无心跳间隔定义，任意阈值会把长任务静默期误标「失联」；待心跳机制议题落地后再引入。
4. **bundle 体积**：React Flow 12.11.3 + dagre 3.1.1 + 样式文本全量内联 562KB（IIFE 外壳不支持 code splitting）。依赖选型已获批准；若未来需要瘦身，两层树场景可按 ADR 记录的触发条件降级自绘布局。
5. **协调器锚点**：tab 存在性探测挂在恒驻 input.right watcher 上；若未来宿主布局在某些形态不渲染输入框工具行，团队 tab 会静默消失（其余功能不受影响）。

## 五、门禁汇总

| 门禁 | 结果 | 基线 |
|---|---|---|
| lint (eslint) | 通过 | — |
| typecheck (server + client) | 通过 | — |
| build (tsc + esbuild bundle + 契约校验) | 通过（562,294 bytes） | — |
| test (vitest) | 242/242 通过 | — |
| cov (v8) | 94.16% 行覆盖 | ≥70% |
| cov:patch (diff-cover) | 97% | ≥80% |
| mutation (Stryker 增量) | 71.97 | ≥70 |
