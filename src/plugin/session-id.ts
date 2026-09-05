/**
 * 会话 ID 白名单（issue #103）：session 参数进入任何路径拼接/文件系统寻址前
 * 的统一防御。口径与 team-overview 先例一致——`/^[A-Za-z0-9_-]{1,128}$/`，
 * 白名单外字符（含路径逃逸 `../`、控制字符、超长）一律拒绝。
 *
 * 0.1.2 P0-2（#180）：本层委托 runtime kernel/names 的统一白名单模块
 * （session/gate_id/mailbox member+uuid/blackboard room 五类集中一处），
 * 导出面保持不变（SESSION_PATTERN / isValidSessionId）。
 *
 * 错误码约定：参数缺失返回既有文案（missing session parameter），格式非法
 * 返回 400 invalid session parameter（对齐 overview 口径）。
 */
import { SESSION_PATTERN as RUNTIME_SESSION_PATTERN, validateSessionId } from "../runtime/index.js";

export const SESSION_PATTERN = RUNTIME_SESSION_PATTERN;

export function isValidSessionId(sessionId: string): boolean {
  return validateSessionId(sessionId);
}