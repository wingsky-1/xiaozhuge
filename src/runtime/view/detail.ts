/**
 * 团队详情只读归约：任务账本 + 信箱头部 + 黑板分片 + 注册表 → 视图模型
 * （issue #130：GUI 面板数据扩展——任务/持久化数据入面板）。
 *
 * 与 view/overview.ts 同款分层纪律：平台无关纯函数，零 IO 零写路径；输入为
 * 调用方已就绪的数据切片（读文件与信箱三段扫描在 plugin 层完成），输出为
 * HTTP 可直接序列化的视图模型。同一输入恒定同一输出：全部排序补 tiebreak、
 * stale 判定时钟显式注入（nowMs 参数，可测）。
 *
 * 脱敏硬约束（payload 不出投影面）：全部输出对象逐字段显式拷贝，禁止
 * `{...record}` 展开原始记录——信封 body、黑板 ext 非白名单键、账本
 * baseline/mutexGroups/dod 一律不出投影面；白名单之外的意外字段会在单测
 * 严格形状断言处失败，构成「字段泄漏即测试失败」防线。
 */
import type { Shard } from "../collab/blackboard.js";
import type { EventRecord } from "../kernel/types.js";
import {
  STALE_THRESHOLD_MS,
  TASK_STATUSES,
  type MemberRecord,
  type TaskRecord,
  type TaskStatus,
  type TeamRegistry,
} from "../kernel/types.js";

/* ── 视图模型 interface（HTTP 响应体形状；见 gui-plan 第一章 1.2）────────── */

/** 任务账本单条投影（来源：Ledger.list() 的 TaskRecord，消费先例 handlers.ts taskList 读面）。 */
export interface TaskLedgerView {
  /** 任务 id（账本内唯一）。 */
  id: string;
  /** 任务标题（主控写入的展示元数据，与 reconcile taskDetails 同级）。 */
  title: string;
  /** 所属房间。 */
  room: string;
  /** 账本登记态原文（历史遗留脏值原样透传展示，计数侧按五值白名单过滤）。 */
  status: TaskStatus;
  /** 当前持有角色；缺省（undefined）保守投影为 null。 */
  assignee: string | null;
  /** 已完成往返圈数。 */
  rounds: number;
  /** 单任务往返上限；缺省保守投影为 null。 */
  maxRounds: number | null;
  /** 计划触碰的路径清单（与 reconcile taskDetails 的 touched_paths 同口径）。 */
  touched: string[];
  /** 乐观并发版本号。 */
  rev: number;
  createdAt: number;
  updatedAt: number;
  /** 任务产物指针；缺省（undefined）保守投影为 null。 */
  artifact: string | null;
}

/** 信封投递三段状态（mailbox 三段式文件位：待读位 / .delivering- / processed/）。 */
export type MailboxEnvelopeState = "unread" | "claimed" | "acked";

/**
 * 信箱信封头部投影。body 永不入此形状（payload 不出投影面）；本 interface 即
 * 白名单闭包——严格形状断言保证未来 Envelope 追加字段不会自动进入投影面。
 */
export interface MailboxHeadView {
  /** 信封 id（= uuid）。 */
  id: string;
  to: string;
  from: string;
  type: string;
  /** 三段状态：unread 待读 / claimed 认领中（瞬态过渡态）/ acked 已确认。 */
  state: MailboxEnvelopeState;
  createdAt: number;
}

/** 单条黑板分片输入切片：listShards 本身无 room 维度，由调用方逐房间读取时附上。 */
export interface RoomShard {
  /** 分片所属房间名。 */
  room: string;
  /** 房间内 per-role 分片快照。 */
  shard: Shard;
}

/** 黑板分片徽标（与 overview「多房间同 role 取字典序首房间」口径不同：全平铺保留房间维度，面向详情核查）。 */
export interface ShardBadgeView {
  room: string;
  role: string;
  /** 分片保留态原文（写入侧强制 running|blocked|done，读侧容忍脏值原样展示不炸归约）。 */
  status: string;
  updatedAt: number;
  /** ext.current_activity 单键提取（与 overview activityFromExt 同款机械取值，零生成）。 */
  currentActivity: string | null;
}

/** ADR 0016 运行态标注单条（成员心跳陈旧标注）。 */
export interface StaleAnnotation {
  member: string;
  /** 心跳年龄：nowMs - lastSeen（时钟回拨时可为负，天然不超阈）。 */
  lastSeenAgeMs: number;
}

/**
 * 事件白名单投影单条（Q2，#162：事件展示层摘要渲染；payload 不出投影面——
 * 仅白名单字段机械摘录，零语言生成）。来源：rooms/<room>/events.jsonl 尾部。
 */
export interface RecentEventView {
  /** 事件所属房间（跨房间无全局唯一 seq，须 room+seq 复合 tiebreak 排序）。 */
  room: string;
  /** 房间内单调自增序号（EventRecord.seq）。 */
  seq: number;
  ts: number;
  /** 动作主体（成员名 / "system"）。 */
  actor: string;
  /** 事件类型原文（team/task/spawn/mailbox/handoff/member/blackboard...）。 */
  type: string;
  /**
   * 按类型白名单机械摘录的展示摘要（不满足守卫条件的类型 → null，类型名
   * 本身已可读）。仅拼白名单标识符（task_id/status/to_role/to/msg_type/
   * member/from/to），非法 payload 字段经 typeof 守卫后摘要置 null。
   */
  summary: string | null;
  /**
   * handoff 事件的逐条回执结论（#98 步骤 3 凭据卡片数据源）。读侧独立守卫：
   * 仅 `pass:/fail:` 前缀行进入，其余丢弃（写路径校验不可信历史/绕过数据）；
   * 条数与单行长度封顶防膨胀（RECEIPT_SUMMARY_LIMIT / RECEIPT_LINE_MAX）。
   */
  receiptSummary: string[] | null;
}

/** 单条事件输入切片：房间名 + 该房间事件流尾部（plugin 层 readEventsTail 读取）。 */
export interface RoomEvent {
  room: string;
  events: readonly EventRecord[];
}

/**
 * 回执摘要条数上限与单行长度上限（#162 评审 P1-6）：judge 大 dod 数组/长结论
 * 不得无限膨胀响应；超限截断（保守丢弃，非报错）。
 */
export const RECEIPT_SUMMARY_LIMIT = 32;
export const RECEIPT_LINE_MAX = 200;

/** 团队详情视图模型（GET /api/xiaozhuge/team/detail 响应体形状）。 */
export interface TeamDetailView {
  /** 注册表非空判定（team.yaml 在场短路在 HTTP 层先行完成）。 */
  isTeam: boolean;
  /** 全量任务投影，按 updatedAt desc（同值 id asc 稳定）。 */
  tasks: TaskLedgerView[];
  /** Ledger.list() 读到的损坏任务文件名（如实透传，HTTP 层仍 200）。 */
  corruptTaskFiles: string[];
  /** 五键恒全量的任务状态计数（空账本全 0，确定性形状供 chips 渲染）。 */
  taskCounts: Record<TaskStatus, number>;
  /** 全成员信箱头部汇总，按 createdAt desc（同值 id asc 稳定）；每成员每 state 最多 MAILBOX_PER_STATE_LIMIT 条。 */
  envelopes: MailboxHeadView[];
  /** 逐房间分片汇总（同 role 多房间全平铺），按 room asc、role asc。 */
  shardBadges: ShardBadgeView[];
  /** tier0 主控 lastSeen 超阈（无 tier0 成员时恒 false）。 */
  masterIdle: boolean;
  /** 心跳超阈且无 blocked 分片的执行成员。 */
  staleMembers: StaleAnnotation[];
  /** 心跳超阈但存在任一房间 blocked 分片的执行成员（等待输入 ≠ 停摆，免责档）。 */
  awaitingInput: StaleAnnotation[];
  /** 全房间事件流尾部白名单投影（Q2，#162），按 room asc、seq desc（同 room 内最新在前）。 */
  recentEvents: RecentEventView[];
}

/** 归约输入整体：调用方已读的切片，与 OverviewInput 先例同构。 */
export interface DetailInput {
  registry: TeamRegistry;
  /** Ledger.list().tasks 全量原始记录。 */
  tasks: readonly TaskRecord[];
  /** Ledger.list().corrupt 损坏文件名清单。 */
  corruptTaskFiles: readonly string[];
  /** 全成员信箱头部汇总（plugin 层 readMailboxHeads 已裁剪为白名单七键）。 */
  mailboxes: readonly MailboxHeadView[];
  /**
   * [偏差-D1] 规范原文写作 `readonly Shard[]`，但 Shard 协议类型无 room 字段
   * 而 shardBadges 需要房间维度（且要求多房间同 role 全平铺）——切片改为
   * 携带房间的 RoomShard[]，TeamDetailView 及其余契约形状不受影响。
   */
  shards: readonly RoomShard[];
  /** 各房间事件流尾部切片（plugin 层 readEventsTail 读取；Q2，#162）。 */
  rooms: readonly RoomEvent[];
  /** 注入时钟（stale 判定与心跳年龄需要；纯函数可测）。 */
  nowMs: number;
}

/**
 * 信箱公平可见性截断上限：每成员每 state（unread/claimed/acked 三段）各最多
 * 5 条、即每成员最多 15 条——防止高频发信方淹没其余成员的可见区。
 */
export const MAILBOX_PER_STATE_LIMIT = 5;

/* ── 纯函数导出 ──────────────────────────────────────────────────────── */

/** TaskStatus 五值白名单守卫（历史遗留账本可能出现非五值脏 status）。 */
function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

/**
 * 任务状态计数：五键恒全量（确定性形状供 chips 渲染）。脏 status（历史遗留
 * 非五值）不炸归约、不计入任何键。注意与 reconcile statusCounts 为稀疏
 * Record<string, number> 仅语义参考、非同一实现。
 */
export function taskCountsOf(tasks: readonly TaskLedgerView[]): Record<TaskStatus, number> {
  const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  for (const t of tasks) {
    if (isTaskStatus(t.status)) counts[t.status] += 1;
  }
  return counts;
}

/** 任务记录 → 白名单投影：逐字段显式拷贝（禁止 spread 原始记录防字段回潮）。 */
function projectTask(t: TaskRecord): TaskLedgerView {
  return {
    id: t.id,
    title: t.title,
    room: t.room,
    status: t.status,
    assignee: t.assignee ?? null,
    rounds: t.rounds,
    maxRounds: t.maxRounds ?? null,
    touched: [...t.touched],
    rev: t.rev,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    artifact: t.artifact ?? null,
  };
}

/** updatedAt desc 排序，同值以 id asc 稳定 tiebreak（uuid 纯 ASCII，字典序确定）。 */
function byUpdatedAtDesc(a: TaskLedgerView, b: TaskLedgerView): number {
  return b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * 信封头部排序与公平截断：全局 createdAt desc（同值 id asc 稳定）后，按
 * 「成员 × state」分桶各保留最新 MAILBOX_PER_STATE_LIMIT 条。
 */
function sortAndCapEnvelopes(
  mailboxes: readonly MailboxHeadView[],
): MailboxHeadView[] {
  const sorted = [...mailboxes].sort(
    (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const seen = new Map<string, number>();
  const kept: MailboxHeadView[] = [];
  for (const head of sorted) {
    // 显式重建对象而非透传引用：即使未来入参意外携带 body 等多余字段，
    // 输出形状也始终锁定七键白名单（防御性拷贝纪律的最后防线）。
    const projected: MailboxHeadView = {
      id: head.id,
      to: head.to,
      from: head.from,
      type: head.type,
      state: head.state,
      createdAt: head.createdAt,
    };
    const bucket = `${head.to}\u0000${head.state}`;
    const count = seen.get(bucket) ?? 0;
    if (count >= MAILBOX_PER_STATE_LIMIT) continue;
    seen.set(bucket, count + 1);
    kept.push(projected);
  }
  return kept;
}

/** 从分片 ext 提取 current_activity（非空字符串才认可；机械取值零生成；其余 ext 键一律不透传）。 */
function currentActivityFromExt(ext: unknown): string | null {
  if (ext !== null && typeof ext === "object") {
    const v = (ext as { current_activity?: unknown }).current_activity;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * ⚠️ 镜像实现注记（R4 双向同步）：本函数与 src/plugin/handlers.ts reconcile
 * 的 stale 标注段（L872-898 附近）是同一口径的镜像实现——reconcile 返回值是
 * 工具输出而非存储，detail 读面无法复用，且「handlers 写路径零触碰」红线禁止
 * 从 handlers 抽公共函数。修订任一侧判定规则（候选过滤 / 超阈比较 / 免责档 /
 * tier0 主控分支）必须双向同步另一侧，并以双方单测锚定 STALE_THRESHOLD_MS
 * 常量推导断言防漂移。口径逐条对齐 ADR 0016：
 * - 候选 = tier ≠ 0 且 status === "running" 且 Number.isFinite(lastSeen)
 *   （dead 一律不收录——lost 着色已表达防双计；spawned/stopped 非干活中）；
 * - 超阈判定 nowMs - lastSeen > STALE_THRESHOLD_MS 严格大于（恰达阈值不算；
 *   时钟回拨负 age 天然不超阈，无需特判）；
 * - 存在任一房间 status === "blocked" 分片者归 awaitingInput 免责档
 *   （等待输入 ≠ 停摆），否则入 staleMembers；
 * - tier0 不入两个名单：超阈单独置 masterIdle = true；注册表无 tier0 成员或
 *   其 lastSeen 非有限 → 恒 false（镜像 handlers Number.isFinite 分支）；
 * - 两名单均按 member localeCompare 升序输出。
 */
export function staleAnnotations(
  registry: TeamRegistry,
  shards: readonly Shard[],
  nowMs: number,
): { masterIdle: boolean; staleMembers: StaleAnnotation[]; awaitingInput: StaleAnnotation[] } {
  // 黑板 blocked 免责索引：任一房间的任一 blocked 分片即豁免（跨房间平铺命中）。
  const blockedRoles = new Set<string>();
  for (const shard of shards) {
    if (shard.status === "blocked") blockedRoles.add(shard.role);
  }
  const members = Object.values(registry.members);
  const candidates = members.filter(
    (m) => m.tier !== 0 && m.status === "running" && Number.isFinite(m.lastSeen),
  );
  const annotate = (m: MemberRecord): StaleAnnotation => ({
    member: m.member,
    lastSeenAgeMs: nowMs - m.lastSeen,
  });
  const byNameAsc = (a: { member: string }, b: { member: string }): number =>
    a.member.localeCompare(b.member);
  const overThreshold = (m: MemberRecord): boolean => nowMs - m.lastSeen > STALE_THRESHOLD_MS;
  const tier0Master = members.find((m) => m.tier === 0);
  return {
    masterIdle:
      tier0Master !== undefined &&
      Number.isFinite(tier0Master.lastSeen) &&
      nowMs - tier0Master.lastSeen > STALE_THRESHOLD_MS,
    staleMembers: candidates
      .filter((m) => overThreshold(m) && !blockedRoles.has(m.member))
      .map(annotate)
      .sort(byNameAsc),
    awaitingInput: candidates
      .filter((m) => overThreshold(m) && blockedRoles.has(m.member))
      .map(annotate)
      .sort(byNameAsc),
  };
}

/**
 * 事件摘要分派（白名单机械摘录，零语言生成——与 currentActivity 同纪律）。
 * 仅拼白名单标识符；payload 字段缺省/类型不符 → 该分支返回 null（保守投影
 * 缺省→null 同口径，杜绝拼出 "undefined" 文案）。
 */
function summaryOf(type: string, payload: unknown): string | null {
  const p = payload as Record<string, unknown> | null;
  if (p === null || typeof p !== "object") return null;
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  switch (type) {
    case "task/update": {
      const id = str(p.task_id);
      const status = str(p.status);
      return id !== null && status !== null ? `task ${id} → ${status}` : null;
    }
    case "handoff": {
      const id = str(p.task_id);
      const to = str(p.to_role);
      return id !== null && to !== null ? `handoff ${id} → ${to}` : null;
    }
    case "mailbox/deliver": {
      const to = str(p.to);
      const msgType = str(p.msg_type);
      return to !== null && msgType !== null ? `deliver ${msgType} -> ${to}` : null;
    }
    case "member/status": {
      // payload = { member, from, to }（handlers.ts transitMemberStatus）。
      const member = str(p.member);
      const from = str(p.from);
      const to = str(p.to);
      return member !== null && from !== null && to !== null
        ? `member ${member}: ${from} → ${to}`
        : null;
    }
    case "team/spawn": {
      const member = str(p.member);
      const role = str(p.role);
      return member !== null && role !== null ? `spawn ${member} (${role})` : null;
    }
    default:
      return null;
  }
}

/**
 * 回执摘要读侧独立守卫（#162 评审 P0-3）：写路径 receipt-format 校验（handlers）
 * 不能保证历史/绕过数据合规——此处逐条独立判断，仅 `pass:/fail:` 开头行进入，
 * 否则整条 receiptSummary 置 null（宁缺勿滥，杜绝任意文本上投影面）。
 */
function receiptSummaryOf(payload: unknown): string[] | null {
  const p = payload as Record<string, unknown> | null;
  if (p === null || typeof p !== "object") return null;
  const raw = p.receipt;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: string[] = [];
  for (const line of raw) {
    if (typeof line !== "string") return null;
    if (!/^\s*(pass|fail)\s*[:：]/i.test(line)) return null;
    out.push(line.slice(0, RECEIPT_LINE_MAX));
    if (out.length >= RECEIPT_SUMMARY_LIMIT) break;
  }
  return out.length > 0 ? out : null;
}

/**
 * 单条事件白名单投影：{seq,ts,actor,type} 直出 + summary/receiptSummary
 * 机械摘录；payload 原样永不入投影面。
 */
export function projectRecentEvent(room: string, e: EventRecord): RecentEventView {
  return {
    room,
    seq: e.seq,
    ts: e.ts,
    actor: e.actor,
    type: e.type,
    summary: summaryOf(e.type, e.payload),
    receiptSummary:
      e.type === "handoff" ? receiptSummaryOf(e.payload) : null,
  };
}

/**
 * 事件投影归约：全房间事件尾部 → 白名单视图，排序（room asc, seq desc——
 * 同 room 最新在前；跨房间按房间名稳定分组）。事件为空/坏行跳过同 readEventsTail。
 */
export function projectRecentEvents(rooms: readonly RoomEvent[]): RecentEventView[] {
  const out: RecentEventView[] = [];
  for (const { room, events } of rooms) {
    for (const e of events) out.push(projectRecentEvent(room, e));
  }
  return out.sort(
    (a, b) => a.room.localeCompare(b.room) || b.seq - a.seq,
  );
}

/**
 * 详情总归约：任务/信箱/分片/注册表切片 → 确定性视图模型（空输入 → 全空形：
 * 五键计数全 0、各区空数组、masterIdle=false、stale/awaiting 空、recentEvents 空）。
 * isTeam 仅由注册表非空判定；tasks 等数据区不因空注册表丢弃（如主控登记前
 * 账本已有历史任务的边界实例仍如实展示，路由层短路与本函数分工见 plugin 层）。
 */
export function reduceDetail(input: DetailInput): TeamDetailView {
  const tasks = [...input.tasks].map(projectTask).sort(byUpdatedAtDesc);
  const badges = input.shards
    .map(({ room, shard }) => ({
      room,
      role: shard.role,
      status: shard.status,
      updatedAt: shard.updatedAt,
      currentActivity: currentActivityFromExt(shard.ext),
    }))
    .sort((a, b) => a.room.localeCompare(b.room) || a.role.localeCompare(b.role));
  const annotations = staleAnnotations(
    input.registry,
    input.shards.map((rs) => rs.shard),
    input.nowMs,
  );
  return {
    isTeam: Object.keys(input.registry.members).length > 0,
    tasks,
    corruptTaskFiles: [...input.corruptTaskFiles],
    taskCounts: taskCountsOf(tasks),
    envelopes: sortAndCapEnvelopes(input.mailboxes),
    shardBadges: badges,
    masterIdle: annotations.masterIdle,
    staleMembers: annotations.staleMembers,
    awaitingInput: annotations.awaitingInput,
    recentEvents: projectRecentEvents(input.rooms),
  };
}
