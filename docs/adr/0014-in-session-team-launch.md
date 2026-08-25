# ADR 0014: 团队拉起入口收敛进会话输入框（官方 slots 客户端插件）

- 状态：Accepted
- 日期：2026-08-26
- 对应 issue：#51 修订（产品反馈：独立入口页与路径填写不符合实际使用形态）

## 背景

ADR 0011 落地后实机使用反馈三个问题：

1. 「创建团队」入口是浮动按钮 + 发送框旁链接，点击**新开独立页** `/xiaozhuge/launch`，
   脱离会话上下文；
2. 独立页要求**手工填写工作区绝对路径**——路径本就随会话存在（会话 cwd），
   填写是重复劳动且易错；
3. 入口页允许任意时刻建团（发过消息的会话也能进），但团队实例语义上
   **只在首轮对话**（会话尚未开始）创建才有意义。

方案评审（对抗性子 agent）指出：初版用 `webserver/index-inject` DOM 注入
（MutationObserver 定位发送按钮）不符合宿主官方扩展机制——宿主提供
`conversation.input.right` 插槽（输入框工具行右端、发送按钮旁边的官方 seat），
且 `ConversationSnapshot.blank` 是宿主导出的「无用户消息」位（首轮判定，
发消息后自动翻转）。DOM 注入在宿主升级时必然失效，官方插槽则随宿主演进。

## 决策

1. **入口收敛进输入框（官方 slots）**：新增浏览器端客户端插件（`dsh.client`
   声明 + `dist/client.js` bundle，契约外壳对齐 dsh-client-modules 加载机制），
   经 `ctx.slots.inject("conversation.input.right", ...)` 注册 React 组件
   「创建团队」按钮——渲染在输入框工具行右端、发送按钮旁边。移除服务端
   `index-inject` DOM 注入（`makeIndexInjections` 删除）。
2. **会话内弹层选场景**：点击按钮在当前会话内弹出场景选择浮层（复用
   `/api/xiaozhuge/team/scenarios` 枚举，source 角标区分 builtin/user/project），
   不再打开独立页面。
3. **工作区随会话推导**：建团请求的 workspace 来自 `session.list` 当前会话行的
   `cwd` 字段（会话工作目录，经 `connection.api.sessions.list` typed RPC 读取），
   不要求用户填写；cwd 缺失时仅提供 builtin/user 场景（project 层需要
   workspace 才能定位）。
4. **仅首轮对话展示**：`InputZone.session.blank`（宿主导出的官方「对话未开始」
   位，发消息后自动翻转 false）且未建团（`/api/xiaozhuge/team/status` 探测）
   时才显示按钮；发过消息或已建团即自动隐藏。
5. **输入框草稿作首条消息**：建团成功后，若输入框有草稿（`InputZone.input.draft`），
   以 `【我的任务】<草稿>` 前缀连同 tier0_prompt 一起经
   `connection.api.sessions.prompt` 投递；草稿为空则只投递规程。
6. **独立入口页保留为兜底**：`/xiaozhuge/launch` 路由与 `launchPageHtml` 不删
   （headless/异常形态仍可用），但 client 插件不再跳转它。
7. **客户端构建链**：`scripts/build-client.mjs`（esbuild，externals 契约外壳对齐
   dsh-plugin-hub build-client 机制）产物 `dist/client.js`；React 等宿主注入
   依赖走 `dsh.client.external` 声明，不打进 bundle；`tsconfig.client.json`
   独立类型检查（DOM lib + jsx）。

## 兼容性

- 服务端路由（scenarios/status/create）与返回形状不变，`handlers.init` 不动；
- 独立入口页仍可手工访问（行为与 ADR 0011 一致），两入口并存不冲突；
- 客户端插件为纯增量（`dsh.client` 声明 + 构建产物），宿主扫描 `dsh.client`
  的包自动加载 `/plugins/<包名>/client.js`，无需 cordis patch；
- 宿主 API 依赖面（session.list/session.prompt/workspace）均为宿主既有稳定
  typed RPC（`connection.api`）。

## 备选方案

| 备选 | 被否理由 |
| --- | --- |
| 保留独立入口页并自动带入 session/workspace | 多一次页面跳转，会话上下文（草稿、选中场景）无法天然带入；弹层方案零跳转 |
| index-inject DOM 注入（初版实现） | 非官方扩展点，宿主升级必然失效（ADR 0011 已声明脆弱点）；官方 `conversation.input.right` 插槽专为此设计 |
| 用 workspace.list 按 sessionIds 反查 workspace | session.list 直接携带 cwd，少一次 RPC、语义更直接 |
| 用 session.history 判首轮 | 需拉全量历史；`blank` 是宿主导出的官方「对话未开始」位，零成本且语义精确 |

## 回滚方式

移除 `dsh.client` 声明 + `dist/client.js` 即恢复 ADR 0011 交互（独立页入口）；
服务端与 handler 层无变化，零成本。`/xiaozhuge/launch` 独立页保留，随时可回退。
