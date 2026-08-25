# ADR 0011: Team 拉起入口与 team_init 工具面下线

- 状态：Accepted
- 日期：2026-08-26
- 对应 issue：#51（维护者裁决留痕见 #39/#11 评论）

## 背景

`team_init` 作为 LLM 工具意味着团队实例化的触发点在对话内：主控不调工具则
规程缺位、场景无法选择（此前硬编码 oss-maintenance）、普通对话也能拉起团队。
维护者设想：独立入口一键建团、创建时即完成持久化、普通对话不支持拉起。

## 决策

1. **实例化移至 HTTP 面**：新增 `/xiaozhuge/launch` 独立入口页与
   `/api/xiaozhuge/team/{scenarios,status,create}` 路由。create 服务端执行
   原 init 逻辑（handler 层保留复用），返回组装好的 tier0_prompt。
2. **一键链路为入口页客户端编排**：workspace.create → session.create →
   team/create → session.prompt（把 tier0_prompt 作为首条消息投递给主控）。
   全部同源调用，复用宿主既有 HTTP API 形状（P4 kill-matrix 已实证）。
3. **场景选择运行时校验**（维护者裁决，非 schema enum）：scenario 为自由
   字符串，两道闸——名字形态 `^[a-z0-9-]+$`（防路径拼接）+
   `templates/<scenario>/team.yaml` 存在；非法给稳定错误码
   `unknown-scenario`（HTTP 400）。场景列表实时扫描 builtin 白名单根。
4. **team_init 从 LLM 工具面下线**（红线，已批准）：注册数 11 → 10；
   schema 面同步删除；p4-kill-matrix 场景脚本改为 HTTP 建团。
5. **宿主页面注入**（已知脆弱点，显式声明）：经 `webserver/index-inject`
   结构化注入脚本——浮动「创建团队」入口 + 发送框旁快捷按钮（best-effort）
   + 团队会话「团队」tab（room.lock/team.yaml 探测，iframe 复用 Gate Console，
   支持 `?session=` 预填）。DOM 定位依赖宿主前端结构，宿主升级可能失效；
   失效不阻塞核心功能（独立页兜底）。
6. **安全语义沿 Gate Console 先例**：create POST 同源 Origin + Fetch
   Metadata 双头断言；status/scenarios 为只读 GET 不校验。

## 兼容性

- 存量已实例化团队不受影响（快照自包含）；
- `handlers.init` 签名向后兼容（无 scenario 参数 = 缺省场景），golden 与
  playbook-guard 测试口径不变；
- 返回值增补 `scenario` 回显字段（只增不改）。

## 备选方案

| 备选 | 被否理由 |
| --- | --- |
| team_init 增加 scenario 参数 | 触发点仍在对话内，无法满足「独立入口一键 init」诉求；且 enum 锁定使新增模板即改 schema 面 |
| 改宿主新会话界面加按钮 | 动宿主升级兼容面，MVP 不值；index-inject 注入已可达成 |
| 阶段化保留 team_init 工具 | 维护者裁决直接下线；回滚路径见下 |

## 回滚方式

还原 host.ts 的 team_init 注册即恢复旧工具面（handler 未删，零成本恢复）；
入口路由与注入为纯增量文件，可整体移除。已初始化实例不受影响。
