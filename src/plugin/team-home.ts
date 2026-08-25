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

/** user 层模板根（ADR 0013）：<DSH_HOME>/xiaozhuge/templates/。 */
export function userTemplatesRoot(): string {
  return join(resolveDshHome(), "xiaozhuge", "templates");
}

/** project 层模板根（ADR 0013）：<projectRoot>/.xiaozhuge/templates/。 */
export function projectTemplatesRoot(projectRoot: string): string {
  return join(projectRoot, ".xiaozhuge", "templates");
}
