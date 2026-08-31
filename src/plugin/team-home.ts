/**
 * 宿主绑定层：TEAM_HOME 解析（ADR 0005/#13 冻结口径）。
 *
 * runtime 纯库只认抽象根；这里把 `<主会话id>` 绑定到
 * `<DSH_HOME>/xiaozhuge/sessions/<主会话id>`，一个主会话 = 一个实例根，
 * 崩溃恢复可借 dsh transcript 回溯。
 *
 * 三级模板来源（ADR 0013）：
 * - user 层 = `<DSH_HOME>/xiaozhuge/templates/`（ADR 0002 定稿落点）
 * - project 层 = `<projectRoot>/.xiaozhuge/templates/`（ADR 0002 定稿落点）
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { sessionIndexFor } from "./session-index.js";

/** 解析 DSH_HOME（默认 ~/.dsh）。 */
export function resolveDshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/**
 * 解析某主会话的 TEAM_HOME 实例根。
 * @param sessionId 主会话 id（dsh session id）。
 */
export function resolveTeamHome(sessionId: string): string {
  return join(resolveDshHome(), "xiaozhuge", "sessions", sessionId);
}

/** 视图解析结果：teamHome 为供数实例根；membership 非空 = 子会话反查命中。 */
export interface TeamHomeResolution {
  teamHome: string;
  /** 命名随 HTTP 响应体 snake_case 口径（is_team/playbook_digest 同风格）。 */
  membership: { root_session: string; member: string } | null;
}

/**
 * 视图供数解析（#97 问题 3）：先按主会话直查；未命中实例根时，按成员
 * durable id 反查所属实例（ADR 0021：优先走 SQLite 反查索引，miss 才回退
 * 全目录扫描并自愈回填）。子会话页据此以实例根身份取数，打通
 * 「子会话 → 所属团队」反向入口。
 *
 * 反查三阶段（ADR 0021）：
 * ① 主会话直查（team.yaml 在场）——快路径，不查索引；
 * ② 索引查询（命中且实例已初始化才信任，保留 team.yaml 守卫防错检）；
 * ③ miss 回退全目录扫描（自愈）——有命中回填索引，无命中登记负缓存
 *    （TTL 内不重复全扫，防无效 id/坏索引放大挂起）。
 *
 * 边界：扫描范围限本 DSH_HOME 的 xiaozhuge/sessions；单实例注册表损坏
 * 跳过继续（不整体失败）；实例未初始化（team.yaml 不在）视为未命中，
 * 与 team/status 判定一致。索引不可用（node:sqlite 缺失/打开失败）时
 * 全程回落旧全扫，行为与引入索引前一致。
 */

/** 负缓存 TTL（ms）：同一 sessionId 全扫未命中后的免扫窗口。 */
export const NEGATIVE_CACHE_TTL_MS = 30_000;
/** 负缓存有界上限（防无效 id 枚举撑爆内存；Map 插入序，超限删最旧）。 */
const NEGATIVE_CACHE_MAX = 1024;
/** 模块级负缓存：sessionId → 过期时间戳。 */
const negativeCache = new Map<string, number>();

function cacheMiss(sessionId: string): void {
  negativeCache.set(sessionId, Date.now() + NEGATIVE_CACHE_TTL_MS);
  if (negativeCache.size > NEGATIVE_CACHE_MAX) {
    // 有界：先清过期项，仍超限删最旧（Map 插入序首个）。
    const now = Date.now();
    for (const [k, exp] of negativeCache) {
      if (exp <= now) negativeCache.delete(k);
    }
    const oldest = negativeCache.keys().next().value;
    if (oldest !== undefined && negativeCache.size > NEGATIVE_CACHE_MAX) negativeCache.delete(oldest);
  }
}

function isCachedMiss(sessionId: string): boolean {
  const exp = negativeCache.get(sessionId);
  if (exp === undefined) return false;
  if (exp > Date.now()) return true;
  negativeCache.delete(sessionId);
  return false;
}

/** 全目录扫描（旧实现，作为索引 miss 的自愈兜底）。 */
function scanSessions(sessionId: string, direct: string): TeamHomeResolution {
  const sessionsDir = join(resolveDshHome(), "xiaozhuge", "sessions");
  let entries: string[] = [];
  try {
    // 显式排序：命中顺序确定化（durable id 全局唯一时理论上无多实例冲突，
    // 排序保证极端情况下行为可复现）。
    entries = readdirSync(sessionsDir).sort();
  } catch {
    return { teamHome: direct, membership: null };
  }
  for (const entry of entries) {
    const teamHome = join(sessionsDir, entry);
    const agentsJson = join(teamHome, "agents.json");
    if (!existsSync(agentsJson) || !existsSync(join(teamHome, "team.yaml"))) continue;
    try {
      const reg = JSON.parse(readFileSync(agentsJson, "utf8")) as {
        members?: Record<string, { durableId?: string; member?: string }>;
      };
      for (const m of Object.values(reg.members ?? {})) {
        if (m.durableId === sessionId && typeof m.member === "string") {
          return { teamHome, membership: { root_session: entry, member: m.member } };
        }
      }
    } catch {
      // 注册表损坏：跳过该实例继续扫描
    }
  }
  return { teamHome: direct, membership: null };
}

export function resolveTeamHomeForView(sessionId: string): TeamHomeResolution {
  const direct = resolveTeamHome(sessionId);
  // ① 主会话直查（快路径）：team.yaml 在场即为团队实例根，无需索引。
  if (existsSync(join(direct, "team.yaml"))) {
    return { teamHome: direct, membership: null };
  }
  // ② 索引反查：命中且实例已初始化（team.yaml 守卫防错检占位实例）。
  const idx = sessionIndexFor();
  if (idx !== null) {
    const hit = idx.get(sessionId);
    if (hit !== undefined) {
      if (existsSync(join(hit.teamHome, "team.yaml"))) {
        return {
          teamHome: hit.teamHome,
          membership: { root_session: basename(hit.teamHome), member: hit.member },
        };
      }
      // 索引命中但实例未初始化（team.yaml 已删/未建）：惰性清条目，回落扫描。
      idx.remove(sessionId);
    }
    // 负缓存：最近全扫未命中的无效/未知 id 短窗内不重复全扫（防放大挂起）。
    if (isCachedMiss(sessionId)) return { teamHome: direct, membership: null };
  }
  // ③ miss 回退：全目录扫描（自愈），有命中回填索引、无命中登记负缓存。
  const scanned = scanSessions(sessionId, direct);
  if (idx !== null) {
    if (scanned.membership !== null) {
      idx.set(sessionId, scanned.teamHome, scanned.membership.member);
      negativeCache.delete(sessionId);
    } else {
      cacheMiss(sessionId);
    }
  }
  return scanned;
}

/** user 层模板根（ADR 0013）：<DSH_HOME>/xiaozhuge/templates/。 */
export function userTemplatesRoot(): string {
  return join(resolveDshHome(), "xiaozhuge", "templates");
}

/** project 层模板根（ADR 0013）：<projectRoot>/.xiaozhuge/templates/。 */
export function projectTemplatesRoot(projectRoot: string): string {
  return join(projectRoot, ".xiaozhuge", "templates");
}
