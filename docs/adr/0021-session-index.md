# ADR 0021: 会话→团队反查索引（SQLite 落盘，替代全目录同步扫描）

- 状态：Accepted
- 日期：2026-08-31
- 对应 issue：#174（连接挂起修复——`/api/xiaozhuge/team/status` 等 HTTP 面每次请求
  同步全目录扫描阻塞事件循环）
- 评审留痕：两轮独立对抗性评审（第一轮扫描缓存方案被否，第二轮索引机制方案
  approve-with-fixes）+ 用户裁决（索引形态 = SQLite 落盘）

## 背景

`resolveTeamHomeForView(sessionId)`（src/plugin/team-home.ts）承担「子会话 durable id
→ 所属实例根 + 成员名」反查，被全部 HTTP 面（status/scenarios/create、gate-console、
overview/detail）与工具面 `handlersFor` 调用。原实现每次调用都**同步全目录扫描**：
`readdirSync(sessionsDir).sort()` + 逐实例 `existsSync`×2 + `readFileSync(agents.json)`
+ JSON.parse + 遍历 members 匹配 durableId。实例多 / agents.json 大时，每次请求同步
阻塞 Node 事件循环 → 后台全部请求 pending（实测 200 实例 × 64KB agents.json：
反查全扫 3.17ms/次 vs SQLite 索引查询 0.008ms/次，收益约 385×）。

参考 dsh-plugin-hub 已验证的连接挂起修复（#268 / #308 / #310 / #287）与用户裁决
「设计索引机制而非扫描缓存」，本 ADR 固化反查索引设计。

## 决策

1. **索引形态：SQLite 落盘（node:sqlite DatabaseSync）**，单表 B-tree 主键：
   ```sql
   CREATE TABLE IF NOT EXISTS session_index (
     session_id TEXT PRIMARY KEY,   -- 子会话 durable id
     team_home TEXT NOT NULL,       -- 实例根绝对路径
     member TEXT NOT NULL           -- 成员名
   );
   ```
   落点 `<DSH_HOME>/xiaozhuge/index.sqlite`（与 sessions/ 平级；可见形态非隐藏点号
   文件，与 events.jsonl 直白风格一致）。node:sqlite 是 Node 内置模块，不算新增
   第三方依赖；引擎声明 node>=22，22.5+ 引入、22.13+/23.4+ 默认可用（仍 experimental），
   feature-detect 降级兜底（见 3）。
2. **写面（仅映射变化时，心跳不触发）**：`handlers.ts` 的 spawn/dispatch 两处
   `upsertMember` 成功路径（registered/revived）后 `indexMember()`——仅 `tier>0`
   （非 tier0 主控）成员入索引（主控 durableId = 主会话 id，team.yaml 直查已覆盖；
   init 登记的 tier0 主控被 `tier>0` 守卫跳过，不重复入索引）；`touchMember`
   （心跳，每次工具调用）与 `setStatus` **不触发**（映射未变，避免高频写放大）。
   登记成功后执行**同 home 写面对账**（`pruneTeam`）：读 agents.json（SOT）在册
   durableId 集合并清理同 teamHome 下不在册的残留条目——覆盖「接管换 durableId」
   场景（旧 durableId 从 SOT 消失后索引残留会被反查误判为成员并残留写权限，QA
   必须修正项）。写失败静默（best-effort，与 ADR 0016 心跳吞错同哲学）。
3. **读面三阶段（同步语义不变）**：
   - ① 主会话直查：`<DSH_HOME>/xiaozhuge/sessions/<sessionId>/team.yaml` 在场即返回
     （O(1) stat，快路径不查索引）；
   - ② 索引查询：命中且实例已初始化（**保留 team.yaml existsSync 守卫**，防错检
     占位实例；命中但未初始化 → 惰性删除该条目）→ 返回归属；
   - ③ miss 回退旧全目录扫描（自愈）：有命中回填索引，无命中登记**负缓存**
     （TTL 30s，有界上限 1024）——同一无效/未知 sessionId 短窗内不重复全扫，
     防坏索引 / 无效 id 枚举放大挂起。
4. **一致性：agents.json 是事实源（SOT），索引是派生物**。失效路径只能是「漏检」
   （miss→回扫自愈回填），不能是「错检」（索引命中分支保留 team.yaml 守卫）。
   dead 成员保留索引（历史归属仍可反查）或随 rebuild 代际消失——文档明示取舍：
   默认保留，重建入口从 agents.json 全量重建后 dead 历史自然消失。
5. **健壮性必配**：`PRAGMA journal_mode=WAL` + `busy_timeout`（多 dsh 实例/测试并行
   共享 DSH_HOME 防 SQLITE_BUSY）；连接打开时 prepare 复用 get/set 语句（读面禁止
   每次 get 都 prepare）；**全程 prepared statement 绑定参数**（durable_id 是 LLM
   输入，禁字符串拼接）+ 键长上限（INDEX_KEY_MAX=256，对齐 SESSION_PATTERN 1-128
   放宽）。
6. **降级（feature-detect）**：node:sqlite 不可用（Node 22.0-22.12 需 flag）或打开
   失败 → `sessionIndexFor()` 返回 null，反查全程回落旧全扫，行为正确性不破、仅损失
   优化；禁用态进程内缓存不重试。配「索引启用自检」测试防 CI 全绿但索引零覆盖。
7. **生命周期**：模块级 per-DSH_HOME 惰性单例（首用才建、打开失败缓存禁用态）；
   `apply` dispose 时 `closeSessionIndex()`（释放 SQLite fd，重载后惰性重开）；
   测试 `resetSessionIndex()` 钩子；`createHandlers` 签名不动（模块级单例注入）。
8. **客户端配套（对齐 dsh-plugin-hub #287）**：新增 `src/client/fetch.ts` 的
   `fetchTimeout(url, init?, timeoutMs=10_000)` 封装——`init.signal` 存在时透传不兜底
   （防双取消竞争）；否则注入超时信号（`AbortSignal.timeout` feature-detect，iOS 旧版
   回退 `setTimeout+AbortController`，timer 随请求结束清理）。替换 `index.tsx` /
   `team-view.tsx` 全部 7 处裸 fetch；launch/gate-console 内联页脚本同样加超时
   （connTimeoutSignal，内联页低频可豁免旧 iOS）。`team-view.tsx` 抽屉轮询
   `setInterval` 改串行自重排（防上一请求挂起时叠加占满浏览器 6 连接池）。

## 备选与裁决

- **读面扫描缓存（mtime 指纹 + LRU）**：用户否决——命中路径仍保留全目录
  readdir+stat 同步遍历，根因未根除；且心跳频繁写 agents.json 使指纹快路径失效。
- **JSONL 反向索引（append-only + 启动回放进内存 Map）**：评审否决——实现量最大
  （回放正确性 / torn line / compact / 内存一致性），审计论据弱（SOT 是 agents.json，
  派生索引无审计价值）。
- **内存 Map（写面双写）**：实现量最小、读 O(1)、零依赖零文件，但**不落盘**
  （重启后首次反查前需全扫一次），且依赖「同进程单写者」前提（ADR 0017 跨进程写
  本属协议违规）。用户裁定选 SQLite 落盘（重启免扫、可审计、B-tree O(log n)）。
- **每实例反向索引文件 + 回退只读目录名**：排除——反向键是子会话 durableId 与
  实例目录名（主会话 id）无关联，只读目录名无法命中；仍是 O(n) 文件读，量级不解决。

## 后果

- 正面：反查由「每次请求同步全目录扫描（3.17ms/次）」降为「索引 O(log n)
  （0.008ms/次）」，收益约 385×；重启免重扫；负缓存限流防无效 id 放大；客户端
  有界等待兜底半开连接；抽屉轮询防叠加；与 overview/detail 投影缓存解耦（指纹
  心跳翻转问题列为相邻 issue 独立跟踪，不在本 ADR 范围）。
- 负面/风险：新增一个二进制派生文件（`index.sqlite` + WAL/-shm 伴生）——文档明示
  「索引为派生物，可删除重建」（删除后 feature-detect 重开）；node:sqlite 仍
  experimental（feature-detect 降级兜住）；目录协议增量（xiaozhuge/ 根下新增
  index.sqlite）——本 ADR 即为协议增量留档。
