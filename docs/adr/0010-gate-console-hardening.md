# ADR 0010: Gate Console 安全加固与自批风险定性

- 状态：Accepted
- 日期：2026-08-26
- 对应 issue：#2 [decision] Gate 安全模型澄清（对抗性评审修订后收口）

## 背景

#2 悬置三项（反自批中间件 / nonce 下发 / Sec-Fetch-Site 硬校验）经独立
对抗性评审后逐一定裁。评审关键结论：

1. 双头校验拦的是**跨站 CSRF**，不防具备 HTTP 能力的 agent 自批——LLM agent
   经 bash/fetch 可零成本伪造 Origin 与 Sec-Fetch-Site；「= 本机进程 = 威胁
   模型外」的旧定性错误归类了「被注入驱动的授权代理」这一威胁；
2. 同源 XSS 是唯一能全灭头校验的路径，且 Console 渲染 gate 内容存在未转义
   直插 innerHTML 的真实缺陷；
3. 提示词层防线对对抗注入弱、对善意越权更弱，只能作为风险接受声明；
4. 威胁模型须补录「局域网他机」（服务监听局域网接口）。

## 决策

1. **双头互证固化**（真值表语义）：POST 一律 Origin 缺失即拒、异源即拒；
   Sec-Fetch-Site 存在且非 same-origin 即拒、**缺失放行**（负例是刻意选择：
   兼容 iOS < 16.4 等无此头设备，勿改为缺失即拒）。审计事件增记
   `sec_fetch_site` 归类（absent-legacy / 取值）与 `remote_ip`。
2. **Console XSS 修复**：全部插值经 esc() 转义；内联 onclick 改事件委托；
   每请求随机 nonce 的 CSP 头（`default-src 'self'; script-src 'nonce-…';
   style-src 'nonce-…'; connect-src 'self'; base-uri 'none';
   frame-ancestors 'none'`）。
3. **自批风险定性 = 残余风险接受 + 检测措施**：审计字段支持事后追责；
   巡场规程「gate 批准只能来自人」条款维持提示词层防线定位。
4. **否决项留痕**：存储型 nonce 对威胁模型无增益（本机可读）；human-present
   challenge（页面显示一次性短码）是后续可选强化，随 #53 Gate 能力重设计
   一并评估；给脚本的正道（loopback 管理 token / CLI 子命令）列为 P1 演进。

## 影响面

- `src/plugin/gate-console.ts`（双端点 SFS 断言、审计扩展、页面加固）；
- 测试新增 SFS 真值表、审计标记、CSP/nonce/转义断言；
- 不触 team_* 工具面与账本/gate 文件协议。

## 回滚方式

还原 gate-console.ts 即恢复旧口径；审计新字段为只增不改，旧回读方缺省容忍。
