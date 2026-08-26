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
import { join } from "node:path";

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
 * durable id 反查所属实例（扫各实例 agents.json，纯读）。子会话页据此
 * 以实例根身份取数，打通「子会话 → 所属团队」反向入口。
 *
 * 边界：扫描范围限本 DSH_HOME 的 xiaozhuge/sessions；单实例注册表损坏
 * 跳过继续（不整体失败）；实例未初始化（team.yaml 不在）视为未命中，
 * 与 team/status 判定一致。
 */
export function resolveTeamHomeForView(sessionId: string): TeamHomeResolution {
  const direct = resolveTeamHome(sessionId);
  if (existsSync(join(direct, "team.yaml"))) {
    return { teamHome: direct, membership: null };
  }
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

/** user 层模板根（ADR 0013）：<DSH_HOME>/xiaozhuge/templates/。 */
export function userTemplatesRoot(): string {
  return join(resolveDshHome(), "xiaozhuge", "templates");
}

/** project 层模板根（ADR 0013）：<projectRoot>/.xiaozhuge/templates/。 */
export function projectTemplatesRoot(projectRoot: string): string {
  return join(projectRoot, ".xiaozhuge", "templates");
}
