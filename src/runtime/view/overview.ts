/**
 * 团队视图只读投影：事件流 + 注册表 + 黑板分片 → 视图模型（issue #68）。
 *
 * 归约与渲染分离（issue 验收第 4 条）：本模块是平台无关纯函数，输入为已
 * 就绪的数据切片（调用方负责读文件与尾部截断），输出为画布可直接渲染的
 * 视图模型——视图正确性 = 归约正确性，全部语义在此单测覆盖。
 *
 * 只读保证：零写路径、零 IO；payload 不出投影面（浏览器侧纯文本渲染，
 * 最小暴露原则）。
 *
 * 着色语义（对抗性评审修订：liveness 优先于活动态——黑板可能是死者遗留的
 * 陈旧数据，注册表终局态一票否决）：
 *   lost（dead 成员） > 黑板 running/blocked/done > idle（spawned/stopped/
 *   无分片等静默态）。stopped 不并入运行类着色（明确不是排队）。
 *   lastSeen 陈旧横切原以「协议无心跳间隔定义」为由在本投影不做；#97 落地
 *   后该理由已被 STALE_THRESHOLD_MS 心跳语义取代（ADR 0016）：stale 标注由
 *   team_reconcile 的 master_idle / stale_members / awaiting_input 承载
 *   （report-only）。本视图仍不做时长横切——着色反映即时活动态，静默时长
 *   语义归对账输出，二者职责正交。
 *   Q3（#164）：tone 兼采 registry.status（Q6 物化终态）与黑板分片双源，
 *   事件流仅补 currentActivity 不做时效衰减判定（不引入时长横切）。
 */
import type { EventRecord, MemberRecord, TeamRegistry } from "../kernel/types.js";
import type { Shard } from "../collab/blackboard.js";

/** 节点着色语义（运行中/阻塞/已完成/静默/失联）+ 图例文案。 */
export type NodeTone = "running" | "blocked" | "done" | "idle" | "lost";

/** 单个房间归约输入：调用方已读取并截断的事件尾部窗口 + 黑板分片。 */
export interface OverviewRoomInput {
  room: string;
  /** 事件尾部窗口（已按 seq 升序；由调用方 tail 截断）。 */
  events: readonly EventRecord[];
  /** 该房间黑板分片快照。 */
  shards: readonly Shard[];
}

/** 归约输入整体。 */
export interface OverviewInput {
  registry: TeamRegistry;
  rooms: readonly OverviewRoomInput[];
}

/** 成员节点视图（L1 树节点 / L2 抽屉详情共用）。 */
export interface MemberNodeView {
  member: string;
  tier: number;
  /** 直接父成员名（根成员为 null）；父未注册时挂 null（前端归 root 层）。 */
  parent: string | null;
  /** 持久身份锚点：执行成员 = durable subagent id；tier0 主控 = 宿主主会话 id（#79）。 */
  durableId: string | null;
  /** agents.json 注册态原文（徽标辅助图标用）；未注册成员无此字段语义 → null。 */
  registryStatus: MemberRecord["status"] | null;
  tone: NodeTone;
  currentActivity: string | null;
  lastSeen: number | null;
}

/** 房间视图（L1 汇总徽标 / L2 抽屉事件摘要共用）。payload 不出投影面。 */
export interface RoomView {
  room: string;
  counts: Record<NodeTone, number>;
  recentEvents: Array<Pick<EventRecord, "seq" | "ts" | "actor" | "type">>;
}

/** 团队总览视图模型。 */
export interface TeamOverview {
  isTeam: boolean;
  /**
   * tier0 主控是否已在册（#79 L3 单一确定信号）：false = 实例已初始化但
   * 主控记录缺失（旧实例兼容态 / 未完成启动握手）→ 前端渲染静态黄条。
   * 注意信号单向：只识别「未登记」，不判定「登记了但未跑对账」。
   */
  masterRegistered: boolean;
  /** 全体注册成员扁平表（前端按 parent 组装 root 主房间的树）。 */
  members: MemberNodeView[];
  rooms: RoomView[];
}

/**
 * 从黑板分片推导活动着色（仅三分支：blocked/running/done，其余一律 idle）。
 * 注意：结果会被 reduceOverview 的 liveness 一票否决覆盖（dead → lost）。
 */
export function toneOfShard(shard: Shard | undefined): Exclude<NodeTone, "lost"> {
  if (shard === undefined) return "idle";
  if (shard.status === "blocked") return "blocked";
  if (shard.status === "running") return "running";
  if (shard.status === "done") return "done";
  return "idle";
}

/**
 * 成员级活动着色（Q3，#164）：registry.status 物化态 + 黑板分片双源驱动。
 *
 * 权威层级（对抗性评审定稿，反例 A–I 消解）：
 *   dead（registry 一票否决，lost）> 黑板分片（blocked/running/done 权威，
 *   与 ADR 0016 §5 免责索引同源）> registry.status（running 补位）> idle。
 * 关键语义：
 *   - 无分片成员 registry=running → running（验收目标 1：无分片也有进度）；
 *   - blocked 唯一权威 = 黑板分片，registry blocked 但无分片仍落 idle（反例 I：
 *     避免「展示 blocked 而免责索引不认」的漂移；Q6 状态机 blocked 与分片 blocked
 *     同源同步写，分片缺失时保守静默）；
 *   - spawned/stopped → idle（stopped 是明确静默而非排队，#97 语义保留）；
 *   - 事件流只补 currentActivity，不参与 tone 判定（禁用全量重放，禁止全量读）。
 */
export function toneOfMember(record: MemberRecord, shard: Shard | undefined): NodeTone {
  if (record.status === "dead") return "lost";
  const fromShard = toneOfShard(shard);
  if (fromShard !== "idle") return fromShard;
  if (record.status === "running") return "running";
  return "idle";
}

/** 从分片 ext 提取 current_activity（非空字符串才认可；机械取值零生成）。 */
function activityFromExt(ext: unknown): string | null {
  if (ext !== null && typeof ext === "object") {
    const v = (ext as { current_activity?: unknown }).current_activity;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * 成员当前活动摘要：优先黑板 ext.current_activity，其次该成员在事件尾部
 * 窗口内最近一条事件的 type（机械取 type 原文，不做语言生成），两者皆无则
 * null。
 */
export function currentActivityOf(
  member: string,
  shard: Shard | undefined,
  events: readonly EventRecord[],
): string | null {
  const fromExt = shard === undefined ? null : activityFromExt(shard.ext);
  if (fromExt !== null) return fromExt;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.actor === member) return e.type;
  }
  return null;
}

/** 单房间计数与事件摘要投影。events 为空/缺文件时返回空态（断网降级同理）。 */
export function reduceRoom(input: OverviewRoomInput): RoomView {
  const counts: Record<NodeTone, number> = { running: 0, blocked: 0, done: 0, idle: 0, lost: 0 };
  for (const shard of input.shards) counts[toneOfShard(shard)] += 1;
  return {
    room: input.room,
    counts,
    recentEvents: input.events.map((e) => ({ seq: e.seq, ts: e.ts, actor: e.actor, type: e.type })),
  };
}

/**
 * 总览归约：注册表成员逐个投影（含未在任何房间写过黑板的成员——灰态可见，
 * 保证 L1 一屏可见全团队），房间逐个投影。registry.members 为空即视为
 * 非团队实例（isTeam=false，路由层据此短路）。
 *
 * 着色优先级（Q3，#164 修订）：dead（registry 一票否决 → lost）> 黑板分片
 * （blocked/running/done 权威，与 ADR 0016 §5 同源）> registry.status（running
 * 补位）> idle。无分片 running 成员即可见（不再「谁写分片谁显示进度」）。
 * 多房间同角色分片并存时取字典序首个房间的分片，确定性可测。
 */
export function reduceOverview(input: OverviewInput): TeamOverview {
  const memberNames = Object.keys(input.registry.members).sort();
  const shardIndex = new Map<string, Shard>();
  const eventsByActor = new Map<string, readonly EventRecord[]>();
  for (const room of input.rooms) {
    for (const shard of room.shards) {
      if (!shardIndex.has(shard.role)) shardIndex.set(shard.role, shard);
    }
    for (const e of room.events) {
      const bucket = eventsByActor.get(e.actor);
      eventsByActor.set(e.actor, bucket === undefined ? [e] : [...bucket, e]);
    }
  }
  const members = memberNames.map((name) => {
    const record: MemberRecord = input.registry.members[name]!;
    const shard = shardIndex.get(name);
    return {
      member: name,
      tier: record.tier,
      parent: record.parent ?? null,
      durableId: record.durableId,
      registryStatus: record.status,
      tone: toneOfMember(record, shard),
      currentActivity: currentActivityOf(name, shard, eventsByActor.get(name) ?? []),
      lastSeen: Number.isFinite(record.lastSeen) ? record.lastSeen : null,
    };
  });
  return {
    isTeam: memberNames.length > 0,
    masterRegistered: memberNames.some((n) => input.registry.members[n]!.tier === 0),
    members,
    rooms: input.rooms.map(reduceRoom),
  };
}
