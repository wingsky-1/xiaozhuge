# ADR 0007: CAS 锁切换 proper-lockfile —— 孤儿接管语义增强

- 状态：Accepted
- 日期：2026-08-26
- 对应 issue：#29 [提案][红线] 引入成熟开源库替换自实现能力（第 C 项）
- 实施分支：`feat/oss-c-lockfile`

## 背景

P2a 的 CAS 锁为 O_EXCL 文件自实现（132 行）：`room.lock` 文件 + 内容比对实现
instance-id 幂等重入；空/坏内容视为孤儿锁，默认拒绝、仅显式 `takeoverOrphan`
接管；死锁恢复归巡场对账。评审（#29）指出其跨平台正确性无保障且缺乏
compromise 检测；用户裁决三操作系统部署适配优先。

## 决策

1. **库**：`proper-lockfile@4.1.2` 精确 pin。选型理由：Node 文件锁事实标准
   （verdaccio 等生产采用）、代码量小可完整审计；不选单人维护 fork
   （供应链单点风险）。
2. **锁形态**：`${resource}.lock` **目录**（mkdir 原子）。rc 前无兼容包袱，
   不为旧版 room.lock 文件残留设计迁移路径。
3. **适配层自管语义**（库不提供）：
   - instance-id 幂等重入：锁目录内 `owner.json` 记录持有者，acquire 前读比对；
   - 孤儿锁保守策略：锁目录存在但无有效 owner 默认拒绝，仅显式
     `takeoverOrphan` 清除接管。
4. **语义增强（本 ADR 核心留痕）**：**不启用库的 mtime 自动过期抢夺作为默认行为**。
   实证依据：库将 stale clamp 到最小 2000ms（`lib/lockfile.js`：
   `options.stale = Math.max(options.stale || 0, 2000)`），活持锁者一旦停止续期
   超过阈值即会被任意竞争者自动 steal——违反定稿「接管是显式决策」口径。
   适配层以足够大的 stale 值禁用该路径；owner 完好但进程已死的残留按冲突拒绝，
   死锁恢复仍归巡场对账。

## 影响

- `acquireCas/releaseCas/withCasLock/peekLock` 对外签名不变，首参语义改为资源基路径。
- 双进程契约测试（互斥 / 幂等重入 / kill -9 后 conflict+reentered）全部保留并复用。
- 时钟漂移风险评估：因不消费 mtime 判定，时钟漂移不再影响任何锁决策。

## 后续

P6b hub 实跑前由 p4-kill-matrix 场景回归复核真实 kill 矩阵行为。
