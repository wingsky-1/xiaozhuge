/**
 * 会话 ID 白名单（issue #103）：session 参数进入任何路径拼接/文件系统寻址前
 * 的统一防御。口径与 team-overview 先例一致——`/^[A-Za-z0-9_-]{1,128}$/`，
 * 白名单外字符（含路径逃逸 `../`、控制字符、超长）一律拒绝。
 *
 * 错误码约定：参数缺失返回既有文案（missing session parameter），格式非法
 * 返回 400 invalid session parameter（对齐 overview 口径）。
 */
export const SESSION_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidSessionId(sessionId: string): boolean {
  return SESSION_PATTERN.test(sessionId);
}
