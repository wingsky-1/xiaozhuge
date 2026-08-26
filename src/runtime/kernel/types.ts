/**
 * runtime 协议类型与常量（P2a 数据内核）。
 *
 * 本包是平台无关纯库：只认调用方传入的相对/绝对 `$TEAM_HOME` 抽象根，
 * 零 harness 依赖。宿主绑定层（把 TEAM_HOME 解析到具体落点）不在此处。
 */

/** 框架保留态三元组——通用归约唯一认可的阶段锚点（业务子状态仅展示）。 */
export const RESERVED_STAGES = ["running", "blocked", "done"] as const;

export type ReservedStage = (typeof RESERVED_STAGES)[number];

/** 模板/Role Spec 三级来源标记（ADR 0002 #13：同名不跨级覆盖，仅标来源）。 */
export const TEMPLATE_SOURCES = ["builtin", "user", "project"] as const;

export type TemplateSource = (typeof TEMPLATE_SOURCES)[number];

/** 框架保留态三元组之外的账本入口态。 */
export const TASK_STATUSES = [
  "queued",
  "running",
  "blocked",
  "done",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * 任务状态机合法迁移表（issue #5「update 强制状态机合法迁移」）。
 * done / cancelled 为终态；blocked 可回 running；queued 只能入 running 或取消。
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["running", "cancelled"],
  running: ["blocked", "done", "cancelled"],
  blocked: ["running", "cancelled"],
  done: [],
  cancelled: [],
};

/** 是否允许从 from 迁移到 to。 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/** 共享任务账本单条记录（每任务一文件，原子写）。 */
export interface TaskRecord {
  /** 任务 id，创建时生成，账本内唯一。 */
  id: string;
  title: string;
  status: TaskStatus;
  /** 所属房间（房间即事件流/黑板组织单元）。 */
  room: string;
  /** 当前持有角色（可随 handoff 变更）。 */
  assignee?: string;
  /** 计划触碰的路径清单（互斥断言依据之一）。 */
  touched: string[];
  /** 互斥组标签：两个 running 任务共享任一组即视为冲突。 */
  mutexGroups: string[];
  /** 已完成往返圈数（资源计数）。 */
  rounds: number;
  /** 单任务往返上限（超限拒绝或转 blocked，由工具层裁决）。 */
  maxRounds: number;
  /** DoD 完成判据清单（judge 回执核验依据）。 */
  dod: string[];
  /** 基线指针（如 git ref），供重做前对账。 */
  baseline?: string;
  /** 产物指针（归档/文件位置）。 */
  artifact?: string;
  /** 乐观并发版本号：每次成功写入 +1。 */
  rev: number;
  createdAt: number;
  updatedAt: number;
}

/** CAS 锁文件内容。 */
export interface LockInfo {
  /** 持有者幂等键（约定为主会话 id，跨重启稳定，由宿主绑定层传入）。 */
  holder: string;
  acquiredAt: number;
}

/** agents.json 成员登记项。 */
export interface MemberRecord {
  /** 成员逻辑名（角色 id）。 */
  member: string;
  /**
   * 成员的持久身份锚点。tier ≥ 1 执行成员 = durable subagent id（父死后凭此
   * 对账）；tier 0 主控例外 = 宿主主会话 id（#79 口径扩展——主控不经 subagent
   * 机制创建，存活以主会话为准，ADR 0006 接管核对据此豁免）。
   */
  durableId: string;
  /** 直接父成员名（根成员为 null）。 */
  parent?: string | null;
  /** 所处层级（0 = Tier-0 主控）。 */
  tier: number;
  status: "spawned" | "running" | "stopped" | "dead";
  lastSeen: number;
}

/** agents.json 注册表。 */
export interface TeamRegistry {
  members: Record<string, MemberRecord>;
}

/** 事件流单条记录（append-only jsonl，一行一条）。 */
export interface EventRecord {
  /** 房间内单调自增序号（从 1 开始）。 */
  seq: number;
  ts: number;
  /** 关联 dsh 主会话 id（ADR 0002 口径的 transcript 关联键）。 */
  session_id: string;
  /** 动作主体（成员名 / "system"）。 */
  actor: string;
  type: string;
  payload: unknown;
}

/** Gate 单向状态。 */
export const GATE_STATUSES = ["pending", "approved", "denied"] as const;

export type GateStatus = (typeof GATE_STATUSES)[number];

/** gates/<id>.json 内容。 */
export interface GateRecord {
  id: string;
  status: GateStatus;
  /** 申请原因（人审批时的上下文）。 */
  reason: string;
  requestedBy: string;
  requestedAt: number;
  resolvedBy?: string;
  resolvedAt?: number;
}

/** 保留态判定（原 isStage，语义收窄为保留态三元组）。 */
export function isReservedStage(value: string): value is ReservedStage {
  return (RESERVED_STAGES as readonly string[]).includes(value);
}
