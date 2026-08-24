/**
 * 宿主绑定层：TEAM_HOME 解析（ADR 0005/#13 冻结口径）。
 *
 * runtime 纯库只认抽象根；这里把 `<主会话id>` 绑定到
 * `<DSH_HOME>/xiaozhuge/sessions/<主会话id>`，一个主会话 = 一个实例根，
 * 崩溃恢复可借 dsh transcript 回溯。
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
