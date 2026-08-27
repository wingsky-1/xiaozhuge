/**
 * 小诸葛 runtime 导出面（P2a 数据内核 + P2b 协作语义，issue #5）。
 * 平台无关纯库：零 harness 依赖、零运行时第三方依赖。
 *
 * 物理分层（仅归类，导出符号与对外 API 不变）：
 * - kernel/   数据内核：类型、路径、原子写、CAS 锁、账本、事件流、门禁、恢复；
 * - collab/   协作语义：信箱三段式、黑板分片；
 * - template/ 模板系统：Team/Role Spec 校验与三级模板加载；
 * - view/     只读投影：事件流/注册表/黑板 → 视图模型纯函数（团队视图）。
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
  TemplateSource,
} from "./kernel/types.js";
export {
  TASK_STATUSES,
  TASK_TRANSITIONS,
  GATE_STATUSES,
  RESERVED_STAGES,
  STALE_THRESHOLD_MS,
  TEMPLATE_SOURCES,
  canTransition,
  isReservedStage,
} from "./kernel/types.js";
export { layout, roomLayout, memberMailboxDir } from "./kernel/paths.js";
export type { Layout, RoomLayout } from "./kernel/paths.js";
export {
  ensureDir,
  linkNoReplace,
  readJson,
  writeJsonAtomic,
  sweepTmp,
  confineToRoot,
  TMP_PREFIX,
} from "./kernel/fs-utils.js";
export {
  acquireCas,
  releaseCas,
  withCasLock,
  peekLock,
  LockConflictError,
} from "./kernel/cas-lock.js";
export { Ledger, findConflicts } from "./kernel/ledger.js";
export type { NewTask, TaskPatch, UpdateOptions } from "./kernel/ledger.js";
export { EventLog, WRITER_LOCK_SUFFIX } from "./kernel/event-log.js";
export type { AppendInput, ReadResult } from "./kernel/event-log.js";
export { Registry } from "./kernel/registry.js";
export { openGate, resolveGate, readGate, listGates } from "./kernel/gates.js";
export {
  recoverDeliveries,
  discardRunningSentinels,
  DEFAULT_DELIVERING_TTL_MS,
} from "./kernel/recovery.js";
export type { DeliveryRecovery, SentinelRecovery } from "./kernel/recovery.js";
export { RuntimeError, LedgerError, LockError, GateError } from "./kernel/errors.js";
export {
  MAILBOX_SEGMENTS,
  DELIVERY_WAKEUP_MATRIX,
  GATE_FLOW,
} from "./kernel/protocol.js";
export * from "./collab/mailbox.js";
export type { Envelope } from "./collab/mailbox.js";
export * from "./collab/blackboard.js";
export type { Shard } from "./collab/blackboard.js";
export * from "./view/overview.js";
export type {
  NodeTone,
  OverviewRoomInput,
  OverviewInput,
} from "./view/overview.js";
export * from "./view/detail.js";
export {
  validateTeamTemplate,
  validateRoleSpec,
  validateRoleSet,
  SECTIONS_REQUIRED_ENUM,
} from "./template/template.js";
export type { ValidationError, ValidationResult } from "./template/template.js";
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
  SCENARIO_PATTERN,
  DEFAULT_SCENARIO,
  resolveBuiltinScenarioDir,
  listBuiltinScenarios,
  builtinTemplatesRoot,
  resolveScenarioDir,
  listScenarios,
} from "./template/template-loader.js";
export type {
  LoadedTemplate,
  Tier0Playbook,
  ScenarioRoot,
  ScenarioEntry,
} from "./template/template-loader.js";
