/**
 * 入路径参数白名单统一（P0-2，#180）：session / gate_id / mailbox member+uuid /
 * blackboard room 五类参数进入任何路径拼接/文件系统寻址前的统一防御。
 *
 * 纪律（评审口径）：
 * - runtime 原语内部 assert（根本防御：所有调用方——工具面与 HTTP 面——都被拦截）；
 * - HTTP 路由层再做早校验返回 400（避免走到原语再映射错误码）；
 * - 校验形态对齐既有先例：session 沿用 issue #103 SESSION_PATTERN（上限 128），
 *   member 沿用 blackboard SHARD_KEY_PATTERN（/^[A-Za-z0-9._-]+$/）并补长度上限；
 *   room / gate_id / envelope uuid 同取通用安全名形态（无路径分隔符/控制字符）。
 *
 * 既有合法输入核验（评审重点）：dsh 会话 id（-/_）、模板 role id（coder、
 * spec-writer）、crypto.randomUUID 的 gate_id 与信封 uuid、"root" 房间名均匹配，
 * 白名单不拒绝任何既有合法输入。
 */
import { RuntimeError } from "./errors.js";

/** 会话 id（沿用 issue #103 口径：`/^[A-Za-z0-9_-]{1,128}$/`）。 */
export const SESSION_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/**
 * 通用安全名：member / room / gate_id / envelope uuid。
 * - 禁止 `/`、`\` 与所有控制字符（拒绝 `../` 等跨段逃逸）；
 * - 禁止首字符 `.`：整体 `.`/`..` 作为单段会在 join 时解析到父级目录
 *   （`mailbox/..` → mailbox 父目录），且点前缀与信箱内部暂存名（.delivering-*、
 *   .tmp-*）冲突、会被待读枚举跳过（隐藏文件语义）；
 * - 长度上限 64（UUID、模板 role id、会话片段均远低于此）。
 */
export const SAFE_NAME_PATTERN = /^(?!\.)[A-Za-z0-9._-]{1,64}$/;

export function validateSessionId(value: unknown): boolean {
  return typeof value === "string" && SESSION_PATTERN.test(value);
}

export function validateMemberName(value: unknown): boolean {
  return typeof value === "string" && SAFE_NAME_PATTERN.test(value);
}

export function validateRoomName(value: unknown): boolean {
  return typeof value === "string" && SAFE_NAME_PATTERN.test(value);
}

export function validateGateId(value: unknown): boolean {
  return typeof value === "string" && SAFE_NAME_PATTERN.test(value);
}

export function validateEnvelopeId(value: unknown): boolean {
  return typeof value === "string" && SAFE_NAME_PATTERN.test(value);
}

function assert(
  ok: boolean,
  code: string,
  pattern: RegExp,
  kind: string,
  value: string,
): void {
  if (!ok) {
    throw new RuntimeError(
      code,
      `${kind} must match ${pattern}, got: ${JSON.stringify(value)}`,
    );
  }
}

/** 会话 id 断言（路由/原语共用）。 */
export function assertSessionId(value: string): void {
  assert(validateSessionId(value), "invalid-session", SESSION_PATTERN, "session", value);
}

/** 成员名断言（信箱/黑板分片键）。 */
export function assertMemberName(value: string): void {
  assert(validateMemberName(value), "invalid-member-name", SAFE_NAME_PATTERN, "member", value);
}

/** 房间名断言（rooms/<room>/ 目录段）。 */
export function assertRoomName(value: string): void {
  assert(validateRoomName(value), "invalid-room-name", SAFE_NAME_PATTERN, "room", value);
}

/** Gate id 断言（gates/<id>.json）。 */
export function assertGateId(value: string): void {
  assert(validateGateId(value), "invalid-gate-id", SAFE_NAME_PATTERN, "gate id", value);
}

/** 信封 uuid 断言（mailbox 三段式文件名段）。 */
export function assertEnvelopeId(value: string): void {
  assert(validateEnvelopeId(value), "invalid-envelope-id", SAFE_NAME_PATTERN, "envelope id", value);
}
