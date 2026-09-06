/**
 * 协议偏差机械检测（#212 P0-2，ADR 0024）——ADR 0015「确定性事实下沉」收尾。
 *
 * 全部 report-only（不阻断、不卡点），定位 = 提高协议偏差检出率 +
 * 沉淀误报率数据（ADR 0015 渐进路线：report-only 跑出数据后再评审硬卡点）。
 *
 * 确定性/判断性分离（ADR 0015 方法论）：
 * - no-delegation / unregistered-dispatch：事件流 kind 计数，纯机械；
 * - brief 三态：文件在场 + 水印标记 + 快照标志，纯机械；
 * - blackboard-silent：**前置条件 = 场景模板声明「黑板产出义务」**
 *   （blackboard_required_roles）——是否应当写黑板是判断性成分，
 *   由场景模板显式声明后才成确定性事实（未声明 = not-applicable）。
 *
 * 复杂度预算（#187 尾窗化不回退）：事件统计对每房间事件流**单遍读取**
 * （EventLog.read(1) 一次），内存内 kinds 过滤，不二次 IO。
 */
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { EventLog } from "./event-log.js";
import { BRIEF_FRAMEWORK_MARKER } from "../template/template-loader.js";
import { layout } from "./paths.js";

/** no-delegation 宽限窗（ms）：init 后该时段内零委派不告警（主控正常读规程/对账）。 */
export const NO_DELEGATION_GRACE_MS = 10 * 60 * 1000;

/** deviation 留痕事件类型（事件流留痕，ADR 0017 单写者串行化约定不受影响）。 */
export const DEVIATION_EVENT = "protocol/deviation";

/** 单遍事件统计产物（跨房间聚合）。 */
export interface ProtocolEventStats {
  /** team/spawn 计数。 */
  spawn: number;
  /** task/create 计数。 */
  taskCreate: number;
  /** mailbox/deliver 计数（半委派形态信号：有投递、无注册无账本）。 */
  deliver: number;
  /** team/init 事件 ts（宽限窗起点；无 init = null）。 */
  initTs: number | null;
  /** 事件流最大 seq（跨房间）。 */
  maxSeq: number;
  /** task/update(status=done) 的 actor → 计数（actor = 任务 assignee 镜像）。 */
  doneMembers: Map<string, number>;
  /** blackboard/set 的 actor → 计数。 */
  blackboardMembers: Map<string, number>;
  /** team/spawn payload 的 member → role（成员角色映射来源）。 */
  memberRoles: Map<string, string>;
  /** protocol/deviation 留痕：payload.check → 首检 seq（幂等去重依据）。 */
  deviations: Map<string, number>;
}

export function emptyEventStats(): ProtocolEventStats {
  return {
    spawn: 0,
    taskCreate: 0,
    deliver: 0,
    initTs: null,
    maxSeq: 0,
    doneMembers: new Map(),
    blackboardMembers: new Map(),
    memberRoles: new Map(),
    deviations: new Map(),
  };
}

/**
 * 跨房间单遍事件统计。每房间事件流各读一次（read(1)），内存过滤，
 * 不做二次 IO。房间事件文件缺失/损坏按该房间零事件处理（对账口径：
 * report-only 宁缺勿滥，损坏文件由 event_cursors 如实呈现）。
 */
export async function collectEventStats(roomsDir: string): Promise<ProtocolEventStats> {
  const stats = emptyEventStats();
  if (!existsSync(roomsDir)) return stats;
  const { readdirSync } = await import("node:fs");
  for (const room of readdirSync(roomsDir)) {
    const file = join(roomsDir, room, "events.jsonl");
    if (!existsSync(file)) continue;
    let log: EventLog;
    try {
      log = new EventLog(file);
      await log.init();
    } catch {
      continue; // 事件文件不可读：该房间按零事件（损坏由 event_cursors 呈现）
    }
    const { events } = await log.read(1);
    for (const ev of events) {
      stats.maxSeq = Math.max(stats.maxSeq, ev.seq);
      switch (ev.type) {
        case "team/init":
          stats.initTs = stats.initTs ?? ev.ts;
          break;
        case "team/spawn": {
          stats.spawn += 1;
          const member = (ev.payload as { member?: unknown }).member;
          const role = (ev.payload as { role?: unknown }).role;
          if (typeof member === "string" && typeof role === "string") {
            stats.memberRoles.set(member, role);
          }
          break;
        }
        case "task/create":
          stats.taskCreate += 1;
          break;
        case "mailbox/deliver":
          stats.deliver += 1;
          break;
        case "task/update": {
          const status = (ev.payload as { status?: unknown }).status;
          if (status === "done") {
            stats.doneMembers.set(ev.actor, (stats.doneMembers.get(ev.actor) ?? 0) + 1);
          }
          break;
        }
        case "blackboard/set":
          stats.blackboardMembers.set(ev.actor, (stats.blackboardMembers.get(ev.actor) ?? 0) + 1);
          break;
        case DEVIATION_EVENT: {
          const check = (ev.payload as { check?: unknown }).check;
          if (typeof check === "string" && !stats.deviations.has(check)) {
            stats.deviations.set(check, ev.seq);
          }
          break;
        }
        default:
          break;
      }
    }
  }
  return stats;
}

// ---------------------------------------------------------------- 评估（纯函数）

export type HealthStatus = "available" | "not-applicable" | "warning";

/** 单检测项：恒在场结构（消费方零条件分支，沿 active_mutex_conflicts 先例）。 */
export interface HealthItem {
  check: string;
  status: HealthStatus;
  detail: string;
  /** 首检留痕 seq（首检当场 append 留痕后由调用方回填；repeat 检出时从留痕读）。 */
  first_detected_seq?: number;
  /** 重复检出（留痕已在场）：detail 已带首检指针，消费方可据此抑制。 */
  repeat?: boolean;
}

export interface ProtocolHealthReport {
  items: HealthItem[];
  warnings: number;
}

/** 检测器输入：评估所需全部确定性事实（调用方收集，本模块零 IO）。 */
export interface ProtocolHealthInput {
  /** 实例是否已初始化（team.yaml 在场）；未初始化时全部 not-applicable。 */
  initialized: boolean;
  /** team.yaml 的 brief_framework_written 标志：true = 新版；null/缺失 = 存量实例。 */
  briefFrameworkWritten: boolean | null;
  /** 实例根 brief 文件是否在场。 */
  briefExists: boolean;
  /** brief 文件内容含框架水印（framework_written / master_written 区分）。 */
  briefHasFrameworkMarker: boolean;
  /** 场景模板声明的黑板产出义务角色（空 = blackboard-silent not-applicable）。 */
  blackboardRequiredRoles: readonly string[];
  /** 事件统计（{@link collectEventStats} 产物）。 */
  stats: ProtocolEventStats;
  /** 当前时间（ms）——宽限窗判定。 */
  nowMs: number;
}

/**
 * 评估协议健康（纯函数，零 IO）。幂等留痕由调用方处理：
 * warning 且 stats.deviations 无留痕 → append {@link DEVIATION_EVENT}
 * 并把新 seq 回填 first_detected_seq；已有留痕 → repeat=true。
 */
export function evaluateProtocolHealth(input: ProtocolHealthInput): ProtocolHealthReport {
  const items: HealthItem[] = [];

  // ---- brief 三态（#212 P0-1/P0-2 合并检测）----
  if (!input.initialized) {
    items.push({ check: "brief", status: "not-applicable", detail: "instance not initialized" });
  } else if (input.briefFrameworkWritten !== true) {
    items.push({
      check: "brief",
      status: "not-applicable",
      detail: "legacy instance (snapshot predates brief artifact; upgrade guidance: see ADR 0024)",
    });
  } else if (!input.briefExists) {
    items.push({
      check: "brief",
      status: "warning",
      detail:
        "brief missing; framework pre-writes it at init. If rebuilding (takeover), write the " +
        "verbatim objective using the instance-root ABSOLUTE path " +
        "`<DSH_HOME>/xiaozhuge/sessions/<sessionId>/" +
        BRIEF_FRAMEWORK_MARKER_PATH_HINT +
        "` — NEVER a relative path (relative writes pollute the workspace cwd)",
    });
  } else if (input.briefHasFrameworkMarker) {
    items.push({
      check: "brief",
      status: "available",
      detail: "framework-written brief present (verbatim objective artifact)",
    });
  } else {
    items.push({
      check: "brief",
      status: "available",
      detail: "brief present without framework watermark (master-rewritten; takeover path)",
    });
  }

  // ---- no-delegation / unregistered-dispatch ----
  if (!input.initialized) {
    items.push({
      check: "delegation",
      status: "not-applicable",
      detail: "instance not initialized",
    });
  } else {
    const delegated = input.stats.spawn > 0 || input.stats.taskCreate > 0;
    if (delegated) {
      items.push({
        check: "delegation",
        status: "available",
        detail: `delegation signals present (spawn=${input.stats.spawn}, task_create=${input.stats.taskCreate})`,
      });
    } else if (input.stats.initTs !== null && input.nowMs - input.stats.initTs < NO_DELEGATION_GRACE_MS) {
      items.push({
        check: "delegation",
        status: "available",
        detail: "within post-init grace window; no delegation signals yet",
      });
    } else if (input.stats.deliver > 0) {
      // 半委派形态：有 mailbox 投递、无注册无账本——违反 Ledger-First，但非零委派。
      items.push({
        check: "delegation",
        status: "warning",
        detail:
          "unregistered dispatch: mailbox deliveries present but no team_spawn and no ledger " +
          "task — Ledger-First requires task_create + dispatch (role_inline) before delivery",
      });
    } else {
      items.push({
        check: "delegation",
        status: "warning",
        detail:
          "no delegation: zero team_spawn / task_create since init while grace window elapsed — " +
          "the team loop never started; orchestration MUST dispatch subagents instead of " +
          "executing solo (note: goal activity is framework-invisible and not observable here)",
      });
    }
  }

  // ---- blackboard-silent（前置：场景模板声明义务）----
  if (!input.initialized || input.blackboardRequiredRoles.length === 0) {
    items.push({
      check: "blackboard-silent",
      status: "not-applicable",
      detail:
        input.initialized
          ? "scenario template declares no blackboard_output obligation (blackboard_required_roles empty)"
          : "instance not initialized",
    });
  } else {
    const silent: string[] = [];
    for (const [member, doneCount] of input.stats.doneMembers) {
      const role = input.stats.memberRoles.get(member);
      if (role === undefined) continue; // spawn 留痕缺失的成员：无法判定义务，宁缺勿滥
      if (!input.blackboardRequiredRoles.includes(role)) continue;
      if ((input.stats.blackboardMembers.get(member) ?? 0) === 0) {
        silent.push(`${member}(${role}, done=${doneCount})`);
      }
    }
    items.push(
      silent.length === 0
        ? {
            check: "blackboard-silent",
            status: "available",
            detail: "all obligation-bound members wrote blackboard shards",
          }
        : {
            check: "blackboard-silent",
            status: "warning",
            detail: `completed without any blackboard/set: ${silent.join(", ")} — materials must be persisted for relay and audit`,
          },
    );
  }

  const warnings = items.filter((i) => i.status === "warning").length;
  return { items, warnings };
}

/** 告警文案里的路径提示片段（复用水印常量拼接，保持单一事实源）。 */
const BRIEF_FRAMEWORK_MARKER_PATH_HINT = "rooms/root/brief/user-request.md";

/**
 * 实例根 brief 文件路径（layout 的便捷组合）。
 */
export function briefFileFor(teamHome: string): string {
  return join(layout(teamHome).roomsDir, "root", "brief", "user-request.md");
}

/**
 * 读取 brief 水印状态（调用方在 reconcile 组装时使用；文件不存在 = false）。
 * 只读内容做标记包含性判定，不把文件内容放进返回值（防大文件进 LLM 上下文）。
 */
export function briefHasFrameworkMarker(teamHome: string): boolean {
  const file = briefFileFor(teamHome);
  if (!existsSync(file)) return false;
  try {
    return readFileSync(file, "utf8").includes(BRIEF_FRAMEWORK_MARKER);
  } catch {
    return false;
  }
}
