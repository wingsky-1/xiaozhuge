/**
 * 小诸葛 runtime 数据内核导出面（P2a，issue #5）。
 * 平台无关纯库：零 harness 依赖、零运行时第三方依赖。
 */
export type {
  TaskRecord,
  TaskStatus,
  EventRecord,
  GateRecord,
  GateStatus,
  LockInfo,
  MemberRecord,
  TeamRegistry,
} from "./types.js";
export {
  TASK_STATUSES,
  TASK_TRANSITIONS,
  GATE_STATUSES,
  RESERVED_STAGES,
  TEMPLATE_SOURCES,
  canTransition,
  isReservedStage,
} from "./types.js";
export { layout, roomLayout, memberMailboxDir } from "./paths.js";
export type { Layout, RoomLayout } from "./paths.js";
export {
  ensureDir,
  linkNoReplace,
  readJson,
  writeJsonAtomic,
  sweepTmp,
  confineToRoot,
  TMP_PREFIX,
} from "./fs-utils.js";
export {
  acquireCas,
  releaseCas,
  withCasLock,
  peekLock,
  LockConflictError,
} from "./cas-lock.js";
export { Ledger, findConflicts } from "./ledger.js";
export type { NewTask, TaskPatch, UpdateOptions } from "./ledger.js";
export { EventLog, WRITER_LOCK_SUFFIX } from "./event-log.js";
export type { AppendInput, ReadResult } from "./event-log.js";
export { Registry } from "./registry.js";
export { openGate, resolveGate, readGate, listGates } from "./gates.js";
export {
  recoverDeliveries,
  discardRunningSentinels,
  DEFAULT_DELIVERING_TTL_MS,
} from "./recovery.js";
export type { DeliveryRecovery, SentinelRecovery } from "./recovery.js";
export { RuntimeError, LedgerError, LockError, GateError } from "./errors.js";
export * from "./mailbox.js";
export type { Envelope } from "./mailbox.js";
export * from "./blackboard.js";
export type { Shard } from "./blackboard.js";
export {
  validateTeamTemplate,
  validateRoleSpec,
  validateRoleSet,
  SECTIONS_REQUIRED_ENUM,
} from "./template.js";
export type { ValidationError, ValidationResult } from "./template.js";
export {
  MAILBOX_SEGMENTS,
  DELIVERY_WAKEUP_MATRIX,
  GATE_FLOW,
} from "./protocol.js";
export {
  loadTemplate,
  instantiateSnapshot,
  builtinScenarioDir,
  TEAM_FILE,
  ROLES_DIR,
  PROMPTS_DIR,
  PLAYBOOKS_DIR,
  TIER0_PLAYBOOK_FILE,
  TIER0_PLAYBOOK_SEPARATOR,
  loadTier0Playbook,
  assembleTier0Prompt,
} from "./template-loader.js";
export type { LoadedTemplate, Tier0Playbook } from "./template-loader.js";
