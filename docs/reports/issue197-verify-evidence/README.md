# #197 隔离实机验证证据（2026-09-05）

> 环境：dsh-verify-isolated 四重隔离（临时 DSH_HOME `/tmp/dsh-verify-9Ogtgv` +
> profile `verify_0ea7c3ba` + 独立端口 40741 + 独立浏览器实例），dsh 0.1.2-rc.1，
> 插件 = 本分支构建产物（dist 579156 bytes，客户端契约断言全过）。

## 验证结论：PASS

launch 页一键建团四步编排全链打通：

```
workspace: 5d442303-148b-4002-b5ae-bebd6375964f        ← workspace/create（RPC 信封）
session: session-56e99890-10c9-493c-87d2-fc526218aa47  ← session/create
team initialized: /tmp/dsh-verify-9Ogtgv/xiaozhuge/sessions/session-…aa47
规程已投递。打开会话 … 即可开始。                        ← session/prompt（含 requestId）
打开 Gate 待办（人审入口）                              ← #195 U0-c 链接在场
```

截图：`launch-team-created.png`（本目录）。

## 深层证据（非仅 HTTP 200）

- team 结构完整落盘：`team.yaml` / `agents.json` / `ledger` / `mailbox` / `gates` / `rooms`；
- 规程首条消息真实进入 dsh 会话持久层：`sessions/--tmp-xzg-197-ws--/session-…/session.jsonl.zstd`
  解压后命中「团队已由人经入口创建」（BOOT_MESSAGE_HEAD 前缀）；
- turn 1 以 `MISSING_CREDENTIAL` 收尾属预期——隔离环境无 DEEPSEEK_API_KEY，
  投递语义已完成，非本修复缺陷。

## 过程中排障记录（防重蹈）

1. **直接打开插件页 `/api` 请求 401**：`/api` 通道走 browserAuth cookie 校验，
   带 token 打开插件页不种 cookie。按真实用户路径（先开主界面完成 token→cookie
   交换）后正常。单测不受影响（node:http 直连不走 browserAuth）。
2. **`gateway/internal: Remote payload must contain exactly one plain-object args
   field`**：首版 payload 直传请求对象。官方 `remoteRequest`（api-gateway）强制
   `payload = {args:{<参数名>: <请求对象>}}`；三个目标方法 descriptor 参数名均为
   `request` → `{args:{request:…}}`。已修正并加契约断言。
3. **重建 dist 后隔离实例不生效**：dsh web 启动时缓存插件模块，link 挂载不热更新。
   必须重启隔离实例（本例 job_kill 触发脚本自动清理后重拉）。
4. **token 提取**：`dsh.log` 中 token 含 `-`/`_`，正则须 `token[=: ]+` 宽松匹配。

## 覆盖面

- 点号 REST 形态（`/api/workspace.create` 等）rc.1 下 404 —— 修复后全链 PASS；
- 测试契约断言同步升级（`tests/plugin/team-launch.test.ts`），CI mutation×4 全绿。
