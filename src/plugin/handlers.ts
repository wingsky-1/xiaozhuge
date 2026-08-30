/**
 * team_* 工具 handler 工厂：纯逻辑层，不依赖 cordis。
 * golden 调用集直接驱动本层断言「工具返回 + 账本/信箱/事件流状态迁移」；
 * 宿主装配层（host.ts）把它包装成 ToolDefinition。
 *
 * 一切校验委托 P2a/P2b 纯库；本层只做参数装配与错误文案包装
 * （定稿 G0 边界：确定性操作在工具内部完成，LLM 只做决策）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  MemberRecord,
  TaskRecord,
  TaskStatus,
  TemplateSource,
  ScenarioRoot,
} from "../runtime/index.js";
import {
  ensureDir,
  writeJsonAtomic,
  layout,
  assembleTier0Prompt,
  builtinTemplatesRoot,
  instantiateSnapshot,
  loadTemplate,
  loadTier0Playbook,
  resolveScenarioDir,
  DEFAULT_SCENARIO,
  Ledger,
  findConflicts,
  EventLog,
  Registry,
  getShard,
  listShards,
  setShard,
  acknowledge,
  claim,
  deliver,
  readUnread,
  PROGRESS_CONTRACT,
  STALE_THRESHOLD_MS,
  acquireCas,
  reachable,
} from "../runtime/index.js";
import { userTemplatesRoot, projectTemplatesRoot } from "./team-home.js";
import { appendToolManifest } from "./tool-manifest.js";
import { auditWorkspace } from "./workspace-audit.js";

/** 统一错误形状：{ error: { code, message } }，模型可读可路由。 */
export class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

/** 包根目录（dist 与 src 双形态均回溯到仓根），builtin 模板定位用。 */
export const PACKAGE_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

function wrap(error: unknown): never {
  if (error instanceof ToolError) throw error;
  const e = error as { code?: string; message?: string };
  throw new ToolError(e.code ?? "internal-error", e.message ?? String(error));
}

/** 必填字符串参数校验（裸 definition 无自动校验，S1 结论）。 */
function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ToolError("invalid-arguments", `string field "${key}" is required`);
  }
  return v;
}

/** 必填数字参数校验。 */
function reqNum(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ToolError("invalid-arguments", `number field "${key}" is required`);
  }
  return v;
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new ToolError("invalid-arguments", `field "${key}" must be a string`);
  return v;
}

function optNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ToolError("invalid-arguments", `field "${key}" must be a number`);
  }
  return v;
}

function optStrArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new ToolError("invalid-arguments", `field "${key}" must be a string array`);
  }
  return v as string[];
}

/** role_inline 白名单（对齐模板 role schema 的动态字段，ADR 0015：随信封投递不持久化）。 */
const ROLE_INLINE_FIELDS = ["prompt", "briefing", "dod", "max_hops", "as_judge"] as const;

function optRoleInline(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const v = args.role_inline;
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ToolError("invalid-arguments", 'field "role_inline" must be an object');
  }
  const inline = v as Record<string, unknown>;
  for (const key of Object.keys(inline)) {
    if (!(ROLE_INLINE_FIELDS as readonly string[]).includes(key)) {
      throw new ToolError("invalid-arguments", `unknown role_inline field "${key}"`);
    }
  }
  if (
    inline.prompt !== undefined &&
    (typeof inline.prompt !== "string" || inline.prompt.length === 0)
  ) {
    throw new ToolError("invalid-arguments", 'role_inline.prompt must be a non-empty string');
  }
  if (
    inline.briefing !== undefined &&
    (typeof inline.briefing !== "string" || inline.briefing.length === 0)
  ) {
    throw new ToolError("invalid-arguments", 'role_inline.briefing must be a non-empty string');
  }
  if (inline.dod !== undefined) {
    const probe = { dod: inline.dod };
    if (optStrArray(probe, "dod") === undefined) {
      throw new ToolError("invalid-arguments", 'role_inline.dod must be a string array');
    }
  }
  if (inline.max_hops !== undefined && (typeof inline.max_hops !== "number" || !Number.isFinite(inline.max_hops))) {
    throw new ToolError("invalid-arguments", 'role_inline.max_hops must be a number');
  }
  if (inline.as_judge !== undefined && typeof inline.as_judge !== "boolean") {
    throw new ToolError("invalid-arguments", 'role_inline.as_judge must be a boolean');
  }
  return inline;
}

/**
 * ADR 0019（#149）：role 提示词确定性注入水印。role 定义是框架生成的**指令**（非数据），
 * 故不复用 boot/progress 段「数据非指令」文案（评审修正：语义矛盾）。
 */
const ROLE_DEFINITION_WATERMARK =
  "===== role definition (framework-generated; template authority — not user data) =====\n";

/**
 * role 提示词解析（ADR 0019，#149）：`role_inline` 显式 `prompt` 优先（向后兼容）；
 * 未传时按 `role` 名从模板快照（TEAM_HOME/team.yaml roles[]，template-loader 已内联
 * `prompt_inlined`）带出原文并加水印注入——补全 ADR 0015 §2「role_inline 定义 |
 * 既有角色名」路径。失败语义（用户裁决）：快照缺失/损坏 → `snapshot-corrupt`；
 * role 不在快照 → `unknown-role`；无 `prompt_inlined` → `missing-role-prompt`。
 * 不静默退化；调用方在半事务之外调用本函数即保证失败无副作用留痕。
 */
function resolveRoleInlinePrompt(
  teamYaml: string,
  role: string,
  inline: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (inline !== undefined && typeof inline.prompt === "string" && inline.prompt.length > 0) {
    return inline; // 显式优先，向后兼容（既有调用方显式传 prompt 行为不变）。
  }
  if (!existsSync(teamYaml)) {
    throw new ToolError("snapshot-corrupt", `team.yaml snapshot missing; cannot resolve role "${role}" prompt`);
  }
  let snap: { roles?: Array<{ id: string; prompt_inlined: unknown }> };
  try {
    snap = JSON.parse(readFileSync(teamYaml, "utf8")) as typeof snap;
  } catch {
    throw new ToolError("snapshot-corrupt", `team.yaml snapshot unreadable; cannot resolve role "${role}" prompt`);
  }
  const entry = (snap.roles ?? []).find((r) => r.id === role);
  if (entry === undefined) {
    throw new ToolError("unknown-role", `role "${role}" not found in template snapshot roles[]`);
  }
  const promptInlined = entry.prompt_inlined;
  if (typeof promptInlined !== "string" || promptInlined.length === 0) {
    throw new ToolError("missing-role-prompt", `role "${role}" has no prompt_inlined in template snapshot`);
  }
  return { ...(inline ?? {}), prompt: ROLE_DEFINITION_WATERMARK + promptInlined };
}

/**
 * 调用者身份（Wave 1b 写面收敛，#123）：root = 主控；member = 已登记成员；
 * undefined = 无团队身份（未登记/未初始化，写操作一律拒绝）。
 * host.ts 装配层经 resolveTeamHomeForView 反查解析后注入。
 */
export type Caller =
  | { kind: "root" }
  | { kind: "member"; member: string }
  | undefined;

/** 主控身份（测试/HTTP 路径显式构造用）。 */
export function rootCaller(): Exclude<Caller, undefined> {
  return { kind: "root" };
}

/** 已登记成员身份（测试构造用）。 */
export function memberCaller(member: string): Exclude<Caller, undefined> {
  return { kind: "member", member };
}

/** 一个团队实例的 handler 集（绑定到某主会话的 TEAM_HOME）。 */
export interface Handlers {
  /** team_init：建目录结构 + agents.json 骨架 + room.lock 幂等占位。 */
  init: (args: Record<string, unknown>) => Promise<unknown>;
  /** team_spawn：登记成员 durable id 入 agents.json。 */
  spawn: (args: Record<string, unknown>) => Promise<unknown>;
  /** team_dispatch（ADR 0015，#67）：spawn → 指派 → 派单复合原语，半事务。 */
  dispatch: (args: Record<string, unknown>) => Promise<unknown>;
  /** team_send：定向信箱投递（含可达性校验 report-only——返回值 warnings 标注，不阻断投递，#138）。 */
  send: (args: Record<string, unknown>) => Promise<unknown>;
  /** team_inbox：读未读 / 认领指定信封。 */
  inbox: (args: Record<string, unknown>) => Promise<unknown>;
  /** team_ack：确认处理完成。 */
  ack: (args: Record<string, unknown>) => Promise<unknown>;
  /** team_task_create / update / list。 */
  taskCreate: (args: Record<string, unknown>) => Promise<unknown>;
  taskUpdate: (args: Record<string, unknown>) => Promise<unknown>;
  taskList: (args: Record<string, unknown>) => Promise<unknown>;
  /** team_state_get / set：黑板读写。 */
  stateGet: (args: Record<string, unknown>) => Promise<unknown>;
  stateSet: (args: Record<string, unknown>) => Promise<unknown>;
  /** team_handoff：显式交接（dod 回执核验）。 */
  handoff: (args: Record<string, unknown>) => Promise<unknown>;
  /** team_reconcile（ADR 0015）：对账全量视图 / scope=audit 旁路 report-only；overview 含互斥冲突标注（#137）。 */
  reconcile: (args: Record<string, unknown>) => Promise<unknown>;
}

export function createHandlers(teamHome: string, sessionId: string, caller: Caller = undefined): Handlers {
  const l = layout(teamHome);
  let ledger: Ledger | undefined;
  let registry: Registry | undefined;
  // 按 room 缓存 EventLog：不同房间各自独立文件，互不串写。
  const eventLogs = new Map<string, EventLog>();

  // Wave 1b 写面收敛（#123）：副作用前强制权限校验。错误码 forbidden 与
  // 既有稳定错误码体系一致；消息仅含调用者自身身份，无信息泄漏。
  function requireRoot(tool: string): void {
    if (caller?.kind !== "root") {
      const who = caller?.kind === "member" ? `member ${caller.member}` : "unauthenticated session";
      throw new ToolError("forbidden", `${who} is not allowed to ${tool}`);
    }
  }
  /** root 或指定成员本人（参数携带的目标身份与调用者一致）。 */
  function requireSelf(tool: string, target: string): void {
    if (caller?.kind === "root") return;
    if (caller?.kind === "member" && caller.member === target) return;
    const who = caller?.kind === "member" ? `member ${caller.member}` : "unauthenticated session";
    throw new ToolError("forbidden", `${who} is not allowed to ${tool}`);
  }
  /** root 或任务当前持有者（assignee 归属校验，需读账本）。返回任务记录，
   *  调用方应把 rev 透传为 update 的 expectRev——读-判-写原子化，防 TOCTOU。 */
  async function requireHolder(tool: string, taskId: string): Promise<TaskRecord> {
    const task = await led().get(taskId);
    if (task === undefined) {
      throw new ToolError("task-not-found", `task ${taskId} does not exist`);
    }
    if (caller?.kind === "root") return task;
    if (caller?.kind === "member" && caller.member === task.assignee) return task;
    const who = caller?.kind === "member" ? `member ${caller.member}` : "unauthenticated session";
    throw new ToolError("forbidden", `${who} is not allowed to ${tool}`);
  }

  // 惰性单例：同一实例根内复用事件游标等内存状态。
  function led(): Ledger {
    return (ledger ??= new Ledger(teamHome, l.ledgerTasksDir));
  }
  function log(room: string): EventLog {
    let entry = eventLogs.get(room);
    if (entry === undefined) {
      entry = new EventLog(join(l.roomsDir, room, "events.jsonl"));
      eventLogs.set(room, entry);
    }
    return entry;
  }
  function reg(): Registry {
    return (registry ??= new Registry(teamHome));
  }

  async function appendEvent(actor: string, type: string, payload: unknown, room = "root"): Promise<void> {
    await ensureDir(join(l.roomsDir, room));
    const eventLog = log(room);
    await eventLog.init();
    await eventLog.append({ session_id: sessionId, actor, type, payload });
  }

  // 心跳刷新（#97，ADR 0016）：归属采事件流 actor 镜像口径——凡调用以成员
  // X 的名义产生账面写副作用（登记/投递/交接）即刷 X 的 lastSeen；"system"
  // 与无归属不刷。caller 权威身份仅承担 forbidden 门（Wave 1b 写面收敛），
  // 不复用于账面归属——对照裁决见 issue #97 评论区 Wave 2 准备段。
  // best-effort：lastSeen 是可再生观测信号，刷新失败不得放大为调用失败
  // （宁漏刷不错杀主事务；下轮成功调用自愈），裁决记录于 ADR 0016。
  async function heartbeat(member: string | undefined): Promise<void> {
    if (member === undefined || member === "system") return;
    try {
      await reg().touchMember(member);
    } catch {
      // 吞错：观测信号一档陈旧不值得告警通道；插入点位于全部业务写成功
      // 之后，此处失败不影响本次调用的语义结果。
    }
  }

  // 成员状态机迁移（Q6，#150）：写者 = 框架事件副作用——调用点在业务写成功
  // 之后显式触发（taskUpdate 认领/完成、stateSet 阻塞申报），不依赖成员自觉
  // 写 agents.json。每次迁移留 `member/status` 事件（actor=system，from→to），
  // 供事件重放重建终态；幂等：同态不重复留痕；未登记成员静默跳过（无状态可迁）。
  async function transitMemberStatus(member: string, to: MemberRecord["status"]): Promise<void> {
    const before = await reg().getMember(member);
    if (before === undefined || before.status === to) return;
    await reg().setStatus(member, to);
    await appendEvent("system", "member/status", { member, from: before.status, to });
  }

  async function assertNoTaskConflict(taskId: string, room: string, touched: string[], mutexGroups: string[]): Promise<void> {
    const { tasks } = await led().list();
    const probe: TaskRecord = {
      id: taskId,
      title: "",
      status: "running",
      room,
      touched,
      mutexGroups,
      rounds: 0,
      maxRounds: 0,
      dod: [],
      rev: 1,
      createdAt: 0,
      updatedAt: 0,
    };
    const conflicts = findConflicts([...tasks.filter((t) => t.id !== taskId), probe]);
    if (conflicts.length > 0) {
      const c = conflicts[0]!;
      throw new ToolError("mutex-conflict", `conflicts with ${c.a === taskId ? c.b : c.a}: ${c.reason}`);
    }
  }

  return {
    async init(args) {
      try {
        for (const dir of [
          l.teamHome,
          l.ledgerTasksDir,
          l.roomsDir,
          join(l.roomsDir, "root"),
          join(l.mailboxDir, "root"),
          l.gatesDir,
          l.archiveDir,
        ]) {
          mkdirSync(dir, { recursive: true });
        }
        // room.lock CAS 幂等：同会话重入成功，异会话重复实例化拒绝。
        const outcome = await acquireCas(l.roomLock, sessionId);
        await reg().write(await reg().read());
        // 场景选择（#47 三级来源解析）：scenario 必选或缺省，source 可选消歧，
        // project_root 控制 project 层参与。同名未指定 source → ambiguous-scenario。
        const scenario = typeof args.scenario === "string" && args.scenario.length > 0
          ? args.scenario
          : DEFAULT_SCENARIO;
        const requestedSource = typeof args.source === "string" && args.source.length > 0
          ? (args.source as TemplateSource)
          : undefined;
        const projectRoot = typeof args.project_root === "string" && args.project_root.length > 0
          ? args.project_root
          : undefined;
        // 三级来源根组装（builtin + user + 可选 project）
        const roots: ScenarioRoot[] = [
          { source: "builtin", dir: builtinTemplatesRoot(PACKAGE_ROOT) },
          { source: "user", dir: userTemplatesRoot() },
        ];
        if (projectRoot !== undefined) {
          roots.push({ source: "project", dir: projectTemplatesRoot(projectRoot) });
        }
        let scenarioDir: string;
        let scenarioSource: TemplateSource;
        try {
          const resolved = resolveScenarioDir(roots, scenario, requestedSource);
          scenarioDir = resolved.dir;
          scenarioSource = resolved.source;
        } catch (error) {
          const msg = (error as Error).message;
          if (msg.startsWith("ambiguous-scenario:")) {
            throw new ToolError("ambiguous-scenario", msg);
          }
          throw new ToolError("unknown-scenario", msg);
        }
        // 模板快照落盘 + Tier-0 组装（#42 分层定稿）：tier0_prompt =
        // 规程全文（playbooks/tier0-playbook.md，唯一事实源）+ 固定分隔符 +
        // 场景 tiers[0].prompt；快照增补 playbook_digest 审计字段。
        const loaded = await loadTemplate(scenarioDir, scenarioSource);
        const playbook = loadTier0Playbook(PACKAGE_ROOT);
        // 工作区持久化（ADR 0015）：audit 扫描根的唯一合法来源（不接受调用方传参）。
        await writeJsonAtomic(l.teamYaml, instantiateSnapshot(loaded, playbook.digest, projectRoot));
        // L1 预登记（#79）：tier0 主控根成员在 init 时入册——G0 边界把
        // agents.json 登记列为运行时确定性操作，不依赖提示词自觉。主控
        // durableId = 宿主主会话 id；status=running（init 由该存活会话触发）。
        // 同会话重入经三态判定的幂等分支自然收敛。并入 team/init 事件载荷，
        // 不另发 spawn 事件（保持事件类型序列契约稳定）。
        const masterMember = (loaded.template.tiers as Array<{ id?: string }>)[0]?.id ?? "master";
        mkdirSync(join(l.mailboxDir, masterMember), { recursive: true });
        const masterOutcome = await reg().upsertMember({
          member: masterMember,
          tier: 0,
          parent: null,
          durableId: sessionId,
          status: "running",
          lastSeen: Date.now(),
        });
        await appendEvent("system", "team/init", {
          instance_note: args.instance_note ?? null,
          lock: outcome,
          master: { member: masterMember, outcome: masterOutcome },
        });
        const tier0PromptPath = (loaded.template.tiers as Array<{ prompt?: string }>)[0]?.prompt ?? "";
        const scenarioPrompt = loaded.prompts[tier0PromptPath] ?? "";
        return {
          ok: true,
          lock: outcome,
          home: l.teamHome,
          scenario,
          source: scenarioSource,
          // L1（#79）：预登记的 tier0 主控成员名与登记形态，供入口层展示。
          master_member: masterMember,
          // ADR 0015 决策 3：tier0_prompt 尾部追加「框架工具面自述」保留段
          //（仅 team_* 自述 + 盲区声明；appendToolManifest 保证不双份）。
          tier0_prompt: appendToolManifest(assembleTier0Prompt(playbook, scenarioPrompt)),
          playbook_digest: playbook.digest,
        };
      } catch (error) {
        wrap(error);
      }
    },

    async spawn(args) {
      try {
        requireRoot("team_spawn");
        const member = reqStr(args, "member");
        const durableId = reqStr(args, "durable_id");
        const role = reqStr(args, "role");
        const tier = optNum(args, "tier");
        const parent = optStr(args, "parent");
        if (tier === undefined) throw new ToolError("invalid-arguments", 'number field "tier" is required');
        await ensureDir(join(l.mailboxDir, member));
        // parent 持久化（#79 顺带修复：此前仅解析未落账，接管层级树缺边）。
        await reg().upsertMember({
          member,
          durableId,
          ...(parent !== undefined ? { parent } : {}),
          tier,
          status: "spawned",
          lastSeen: Date.now(),
        });
        await appendEvent("system", "team/spawn", {
          member,
          durable_id: durableId,
          role,
          tier,
          ...(parent !== undefined ? { parent } : {}),
        });
        return { ok: true, member, durable_id: durableId };
      } catch (error) {
        wrap(error);
      }
    },

    async dispatch(args) {
      try {
        requireRoot("team_dispatch");
        const member = reqStr(args, "member");
        const durableId = reqStr(args, "durable_id");
        const role = reqStr(args, "role");
        const tier = reqNum(args, "tier");
        const parent = optStr(args, "parent");
        const taskId = reqStr(args, "task_id");
        const from = optStr(args, "from") ?? "root";
        const provider = optStr(args, "provider");
        const model = optStr(args, "model");
        const inline = optRoleInline(args);
        const expectRev = optNum(args, "expect_rev");

        // 前置校验（无副作用，不参与半事务）：任务必须在场——账本先行约定。
        const task = await led().get(taskId);
        if (task === undefined) {
          throw new ToolError("task-not-found", `task ${taskId} does not exist`);
        }
        // 重复派发拒绝（Q5，#159，评审裁决）：任务已被**其他**成员持有即拒。
        // 判据 = assignee 占用（`(role, task_id)` 的充分条件——同 role 二次派发
        // 必触发 assignee 已占；顺带覆盖「换不同 role 派发已分配任务」的越权
        // 面）；`assignee === member` 放行——半事务失败重试的幂等口子
        // （at-least-once，与既有幂等重入测试一致）。换持有者走 team_handoff
        // （requireHolder + update），不经 dispatch，不受影响。
        if (task.assignee !== undefined && task.assignee !== member) {
          throw new ToolError(
            "duplicate-dispatch",
            `task ${taskId} is already assigned to ${task.assignee}; hand off to change holder`,
          );
        }

        // ADR 0019（#149）：role 提示词确定性注入。显式 role_inline.prompt 优先；
        // 未传时按 role 名从模板快照带出 prompt_inlined 原文并加水印（补全 ADR 0015
        // 「既有角色名」路径）。解析失败发生在半事务之外，无 spawn/assign/send 副作用。
        const resolvedInline = resolveRoleInlinePrompt(l.teamYaml, role, inline);

        // 半事务执行：任一步失败即停，已完成步骤随错误留痕（ADR 0015）。
        const completed: string[] = [];
        try {
          // step 1: 注册（三态 upsert，与 team_spawn 同一落账函数；幂等重入
          // 走同 member+同 durableId 分支）。
          await ensureDir(join(l.mailboxDir, member));
          await reg().upsertMember({
            member,
            durableId,
            ...(parent !== undefined ? { parent } : {}),
            tier,
            status: "spawned",
            lastSeen: Date.now(),
          });
          await appendEvent("system", "team/spawn", {
            member,
            durable_id: durableId,
            role,
            tier,
            ...(parent !== undefined ? { parent } : {}),
            ...(provider !== undefined ? { provider } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(resolvedInline !== undefined ? { role_inline: resolvedInline } : {}),
          });
          completed.push("spawn");
          // step 2: 指派（乐观锁透传，防并发误派）。
          const updated = await led().update(
            taskId,
            { assignee: member },
            { ...(expectRev !== undefined ? { expectRev } : {}) },
          );
          await appendEvent(member, "task/update", {
            task_id: taskId,
            status: updated.status,
            rev: updated.rev,
            // PR-C（#169）：同 taskUpdate 路径一致，事件 payload 带 title。
            title: updated.title,
          });
          completed.push("assign");
          // step 3: 派单信封（role_inline 与模型档位随信封投递给成员；
          // 进度契约为框架注入的固定段——开工/里程碑/完成回执不靠成员自觉）。
          const envelopeId = await deliver(teamHome, member, {
            from,
            type: "task-assign",
            body: {
              task_id: taskId,
              title: task.title,
              room: task.room,
              dod: task.dod,
              role_inline: resolvedInline ?? null,
              provider: provider ?? null,
              model: model ?? null,
              progress_contract: PROGRESS_CONTRACT,
            },
          });
          await appendEvent(from, "mailbox/deliver", {
            to: member,
            envelope_id: envelopeId,
            msg_type: "task-assign",
            task_id: taskId,
          });
          completed.push("send");
          return {
            ok: true,
            member,
            durable_id: durableId,
            task_id: taskId,
            envelope_id: envelopeId,
            steps: completed,
          };
        } catch (error) {
          const e = error as { code?: string; message?: string };
          // 已知稳定错误码原样透传（可路由），其余归并为 dispatch-partial；
          // 两种形态都携带已完成步骤，供主控决定续跑或回滚。
          const code = e.code ?? "dispatch-partial";
          throw new ToolError(
            code,
            `dispatch stopped after [${completed.join(", ") || "none"}]: ${e.message ?? String(error)}`,
          );
        }
      } catch (error) {
        wrap(error);
      }
    },

    async send(args) {
      try {
        const to = reqStr(args, "to");
        const from = reqStr(args, "from");
        requireSelf("team_send", from);
        const type = reqStr(args, "type");
        const body = args.body ?? null;
        if ((await reg().getMember(to)) === undefined) {
          throw new ToolError("unknown-member", `recipient ${to} is not registered`);
        }
        // 可达性校验（#138，report-only 过渡档）：unknown-member 在册检查
        // 保持首位；此后从 team.yaml 快照读 comm_mode/comm（缺省 auto；
        // 旧快照无此字段按缺省容忍），对注册表成员树做可达性判定。
        // 过渡档语义：不可达**照常投递**，原因经返回值 warnings 当场呈现
        // （ADR 0015 report-only 先例——投递已发生，事后标注价值弱于
        // mutex 案，故警告放返回值而非仅事件流）。
        let commMode: "auto" | "explicit" = "auto";
        let comm: Array<{ from: string; to: string }> = [];
        if (existsSync(l.teamYaml)) {
          try {
            const snap = JSON.parse(readFileSync(l.teamYaml, "utf8")) as {
              comm_mode?: unknown;
              comm?: unknown;
            };
            if (snap.comm_mode === "explicit") commMode = "explicit";
            if (Array.isArray(snap.comm)) {
              comm = snap.comm.filter(
                (e): e is { from: string; to: string } =>
                  typeof e === "object" && e !== null &&
                  typeof (e as { from?: unknown }).from === "string" &&
                  typeof (e as { to?: unknown }).to === "string",
              );
            }
          } catch {
            // 快照损坏：按 auto 缺省判定，不阻断投递（report-only 兜底）。
          }
        }
        const registry = await reg().read();
        const members = Object.values(registry.members ?? {});
        const verdict = reachable(members, from, to, commMode, comm);
        const envelopeId = await deliver(teamHome, to, { from, type, body });
        // 计账增补 task_id（若 body 为对象且携带非空字符串）：对账时「哪封信对应
        // 哪个任务」不必再开信封比对，机械可得。body 无类型约束（schemas 声明
        // any JSON value），null 是合法负载——必须先收窄再取值（#131：解引用
        // 先行会把可预期的输入态伪装成 internal-error 故障）。
        const rawTaskId =
          body !== null && typeof body === "object"
            ? (body as { task_id?: unknown }).task_id
            : undefined;
        const bodyTaskId =
          typeof rawTaskId === "string" && rawTaskId.length > 0 ? rawTaskId : undefined;
        await appendEvent(from, "mailbox/deliver", {
          to,
          envelope_id: envelopeId,
          msg_type: type,
          ...(bodyTaskId !== undefined ? { task_id: bodyTaskId } : {}),
        });
        // #97 心跳：发件是最廉价可靠的活性信号（白名单 team_send(from)）。
        await heartbeat(from);
        // warnings 恒在场（固定输出 schema，ADR 0015:48）：可达且树健康时
        // 为空数组，不可达/违规时携带原因（report-only，不阻断投递）。
        return { ok: true, envelope_id: envelopeId, warnings: verdict.warnings };
      } catch (error) {
        wrap(error);
      }
    },

    async inbox(args) {
      try {
        const member = reqStr(args, "member");
        requireSelf("team_inbox", member);
        const uuid = optStr(args, "envelope_id");
        if (uuid !== undefined) {
          const claimed = await claim(teamHome, member, uuid);
          // #97 心跳：认领是成员自己完成的投递写副作用（白名单仅 claim 分支；
          // readUnread 是纯读不刷——宁漏刷不可错刷）。
          await heartbeat(member);
          return { ok: true, envelope: claimed };
        }
        return { ok: true, unread: await readUnread(teamHome, member) };
      } catch (error) {
        wrap(error);
      }
    },

    async ack(args) {
      try {
        const member = reqStr(args, "member");
        requireSelf("team_ack", member);
        const uuid = reqStr(args, "envelope_id");
        await acknowledge(teamHome, member, uuid);
        await appendEvent(member, "mailbox/ack", { envelope_id: uuid });
        // #97 心跳：确认处理完成是成员活性信号（白名单 ack(member)）。
        await heartbeat(member);
        return { ok: true };
      } catch (error) {
        wrap(error);
      }
    },

    async taskCreate(args) {
      try {
        requireRoot("team_task_create");
        const title = reqStr(args, "title");
        const room = reqStr(args, "room");
        const assignee = optStr(args, "assignee");
        const touched = optStrArray(args, "touched_paths");
        const mutexGroups = optStrArray(args, "mutex_groups");
        const maxRounds = optNum(args, "max_rounds");
        const dod = optStrArray(args, "dod");
        const baseline = optStr(args, "baseline");

        // 创建前互斥预检：与现存 running 任务冲突即拒（不留半成品任务）。
        await assertNoTaskConflict("pending-create", room, touched ?? [], mutexGroups ?? []);
        const task = await led().create({
          title,
          room,
          ...(assignee !== undefined ? { assignee } : {}),
          ...(touched !== undefined ? { touched } : {}),
          ...(mutexGroups !== undefined ? { mutexGroups } : {}),
          ...(maxRounds !== undefined ? { maxRounds } : {}),
          ...(dod !== undefined ? { dod } : {}),
          ...(baseline !== undefined ? { baseline } : {}),
        });
        await appendEvent(assignee ?? "system", "task/create", { task_id: task.id, title, room });
        return { ok: true, task_id: task.id, status: task.status };
      } catch (error) {
        wrap(error);
      }
    },

    async taskUpdate(args) {
      try {
        const taskId = reqStr(args, "task_id");
        // Wave 1b（#123）：仅持有者（或主控）可更新；authz 读回 rev 作为
        // 乐观锁基线透传 expectRev——读-判-写原子化，防 root 改派竞态（TOCTOU）。
        const held = await requireHolder("team_task_update", taskId);
        // Wave 1b（#123）：assignee 变更仅主控（或 handoff 路径）可操作——
        // 子代理 patch assignee 可绕过 handoff 的 dod 回执校验，必须禁止。
        if (caller?.kind === "member" && args.assignee !== undefined) {
          throw new ToolError("forbidden", `member ${caller.member} is not allowed to reassign task`);
        }
        const status = optStr(args, "status");
        const rounds = optNum(args, "rounds");
        // 调用方显式 expectRev 优先（显式乐观锁语义）；缺省用 authz 基线。
        const expectRev = optNum(args, "expect_rev") ?? held.rev;
        const updated = await led().update(
          taskId,
          {
            ...(status !== undefined ? { status: status as TaskStatus } : {}),
            ...(optStr(args, "assignee") !== undefined
              ? { assignee: optStr(args, "assignee") as string }
              : {}),
            ...(rounds !== undefined ? { rounds } : {}),
            ...(optStr(args, "artifact") !== undefined
              ? { artifact: optStr(args, "artifact") as string }
              : {}),
          },
          { expectRev },
        );
        await appendEvent(updated.assignee ?? "system", "task/update", {
          task_id: taskId,
          status: updated.status,
          rev: updated.rev,
          // PR-C（#169，已 approved）：事件流 payload 增 title 白名单字段——
          // 供 detail 事件摘要展示任务标题（summaryOf task/update 分支读侧守卫
          // 兼容历史无 title 事件退化旧格式）。事件流写面变更，ADR 0017 串行化
          // 写者约定不受影响（payload 形状无关，仅字段增量）。
          title: updated.title,
        });
        // #97 心跳：归属取 assignee 字段（事件流 actor 镜像）而非调用者——
        // 主控代管更新给被代管者续命，列为 ADR 0016 已接受限制（有事件流审计痕迹）。
        await heartbeat(updated.assignee);
        // Q6（#150）：成员状态机——认领（→running）与完成（该成员无其他活动任务
        // →stopped）由框架事件副作用驱动；未登记/同态静默，不打断业务结果。
        const assignee = updated.assignee;
        if (assignee !== undefined && assignee !== "system") {
          if (updated.status === "running") {
            await transitMemberStatus(assignee, "running");
          } else if (updated.status === "done" || updated.status === "cancelled") {
            const { tasks } = await led().list();
            const hasActive = tasks.some(
              (t) => t.assignee === assignee && t.status !== "done" && t.status !== "cancelled",
            );
            if (!hasActive) {
              await transitMemberStatus(assignee, "stopped");
            }
          }
        }
        return { ok: true, task_id: taskId, status: updated.status, rev: updated.rev };
      } catch (error) {
        wrap(error);
      }
    },

    async taskList(args) {
      try {
        const { tasks, corrupt } = await led().list();
        const room = optStr(args, "room");
        const status = optStr(args, "status");
        const filtered = tasks.filter(
          (t) => (room === undefined || t.room === room) && (status === undefined || t.status === status),
        );
        return { ok: true, tasks: filtered, corrupt_files: corrupt };
      } catch (error) {
        wrap(error);
      }
    },

    async stateGet(args) {
      try {
        const room = reqStr(args, "room");
        const role = optStr(args, "role");
        if (role !== undefined) {
          return { ok: true, shard: (await getShard(teamHome, room, role)) ?? null };
        }
        return { ok: true, shards: await listShards(teamHome, room) };
      } catch (error) {
        wrap(error);
      }
    },

    async stateSet(args) {
      try {
        const room = reqStr(args, "room");
        const role = reqStr(args, "role");
        // Wave 1b（#123）：限自身 = 分片 key（role）必须等于调用者成员名。
        // room 是组织单元不参与归属判定——成员可写自身分片到任意 room
        // （含 root），属设计口径：room 仅作命名空间，非权限边界。
        requireSelf("team_state_set", role);
        const status = reqStr(args, "status");
        const ext = args.ext;
        const shard = await setShard(teamHome, room, role, {
          status: status as Parameters<typeof setShard>[3]["status"],
          ...(ext !== undefined ? { ext } : {}),
        });
        await appendEvent(role, "blackboard/set", { room, status: shard.status });
        // #97 心跳：分片自写是成员活性信号（白名单 state_set(role)）。
        await heartbeat(role);
        // Q6（#150）：阻塞/恢复申报同步成员状态——黑板 blocked 分片是框架可观测的
        // 显式阻塞信号（ADR 0016 免责索引同源）；running 分片同步恢复。done 不驱动
        // 成员态（成员 stopped 由任务全部结束驱动，避免完成分片即误标终止）。
        if (shard.status === "blocked") {
          await transitMemberStatus(role, "blocked");
        } else if (shard.status === "running") {
          await transitMemberStatus(role, "running");
        }
        return { ok: true, role, status: shard.status };
      } catch (error) {
        wrap(error);
      }
    },

    async handoff(args) {
      try {
        const taskId = reqStr(args, "task_id");
        const toRole = reqStr(args, "to_role");
        // Wave 1b（#123）：仅当前持有者可交接；主控可代管。requireHolder
        // 返回任务记录（含 rev），复用避免二次读账本。
        const task = await requireHolder("team_handoff", taskId);
        // Wave 1b（#123）：to_role 必须是已登记成员——防 dangling assignee 出厂。
        if ((await reg().getMember(toRole)) === undefined) {
          throw new ToolError("unknown-member", `handoff target ${toRole} is not registered`);
        }
        const receipt = optStrArray(args, "receipt");
        if (receipt === undefined && task.dod.length > 0) {
          throw new ToolError(
            "receipt-required",
            `task ${taskId} has dod items; attach a per-item pass/fail receipt array`,
          );
        }
        if (receipt !== undefined) {
          if (receipt.length < task.dod.length) {
            throw new ToolError(
              "receipt-incomplete",
              `dod has ${task.dod.length} items but receipt has ${receipt.length} conclusions`,
            );
          }
          // 逐条结论格式校验（10§3.3 文档宣称的兑现，#98 步骤 2）：
          // 每条必须以 pass:/fail: 开头附一句话结论——回执是 judge 的
          // 结构化凭据，自由文本无法被凭据卡片与对账消费。
          const badIdx = receipt.findIndex((line) => !/^\s*(pass|fail)\s*[:：]/i.test(line));
          if (badIdx >= 0) {
            throw new ToolError(
              "receipt-format",
              `receipt[${badIdx}] must start with "pass:" or "fail:" followed by a one-line conclusion`,
            );
          }
        }
        // handoff 只换持有者；任务在 blocked 时随交接恢复 running，其余态不变
        // （running→running 是非法迁移，交给状态机校验兜底）。
        // 透传 authz 读回的 rev 作乐观锁基线（TOCTOU 防护，同 taskUpdate）。
        const updated = await led().update(taskId, {
          assignee: toRole,
          ...(task.status === "blocked" ? { status: "running" as TaskStatus } : {}),
        }, { expectRev: task.rev });
        await appendEvent(toRole, "handoff", { task_id: taskId, to_role: toRole, receipt: receipt ?? null });
        // #97 心跳：归属取交接目标（事件流 actor 镜像，白名单 handoff(toRole)）
        // 而非调用者——同 taskUpdate 代管口径（ADR 0016 已接受限制）。
        await heartbeat(toRole);
        return { ok: true, task_id: taskId, assignee: updated.assignee, rev: updated.rev };
      } catch (error) {
        wrap(error);
      }
    },
    async reconcile(args) {
      try {
        const scope = optStr(args, "scope") ?? "overview";
        if (scope !== "overview" && scope !== "audit") {
          throw new ToolError("invalid-arguments", 'field "scope" must be "overview" or "audit"');
        }

        // 实例快照摘要（team.yaml 在场性 = 已初始化判定，与 HTTP status 端点一致）。
        let snapshot: Record<string, unknown> | null = null;
        if (existsSync(l.teamYaml)) {
          try {
            snapshot = JSON.parse(readFileSync(l.teamYaml, "utf8")) as Record<string, unknown>;
          } catch {
            snapshot = null; // 快照损坏：按未摘要化处理，不阻断账本/注册表对账
          }
        }

        const { tasks } = await led().list();
        const registry = await reg().read();
        const members = Object.values(registry.members ?? {});

        // 成员账本对照：assignee 视角聚合；存活列诚实标注框架不可见（V3）。
        // Q6 PR-3a（#150）：assignee 语义 = 「当前受理人」——只聚合活动任务
        // （非 done/cancelled），done 任务不再计入 assigned_task_ids。历史归属
        // 由事件流 task/update 与 handoff 留痕承载，账本不承担永久归属
        // （#147 Q6.4：master.assigned_task_ids 残留已 done 任务的实证修正）。
        const byAssignee = new Map<string, string[]>();
        for (const t of tasks) {
          if (t.assignee === undefined) continue;
          if (t.status === "done" || t.status === "cancelled") continue;
          byAssignee.set(t.assignee, [...(byAssignee.get(t.assignee) ?? []), t.id]);
        }
        // 存量兼容（Q6 PR-2，#150）：PR-1 之前的会话成员状态从不迁移（setStatus 零调用），
        // 任务已全部结束的成员仍停在 spawned。读路径语义适配（不写盘、无迁移脚本）：
        // 「有任务记录且全部 done/cancelled」的 spawned 成员按 stopped 展示——
        // 曾开工已收尾，非「从未派活」的刚 spawn 成员（后者保持 spawned 原样）。
        const hasAnyTask = (member: string): boolean => tasks.some((t) => t.assignee === member);
        const hasActiveTask = (member: string): boolean =>
          tasks.some((t) => t.assignee === member && t.status !== "done" && t.status !== "cancelled");
        const memberLedger = members.map((m) => ({
          member: m.member,
          durable_id: m.durableId,
          tier: m.tier,
          parent: m.parent ?? null,
          status:
            m.status === "spawned" && hasAnyTask(m.member) && !hasActiveTask(m.member)
              ? ("stopped" as const)
              : m.status,
          liveness: "framework-invisible",
          assigned_task_ids: byAssignee.get(m.member) ?? [],
        }));
        // 悬空态检测：账本指派了、但注册表无此成员。
        const registeredNames = new Set(members.map((m) => m.member));
        const dangling_assignees = [...byAssignee.keys()].filter((a) => !registeredNames.has(a));

        // 孤儿检测（report-only）：非根成员缺 parent 或 parent 未在册即标出，
        // 供主控/视图核对协作链路；硬校验待误报率数据产出后另行评审。
        // tier=0 根主控豁免（单入口原则：有且仅有一个无父主控）。
        const orphan_members = members
          .filter((m) => m.tier !== 0)
          .filter((m) => m.parent === undefined || m.parent === null || !registeredNames.has(m.parent))
          .map((m) => ({
            member: m.member,
            tier: m.tier,
            parent: m.parent ?? null,
            reason: m.parent === undefined || m.parent === null ? "parent-missing" : "parent-dangling",
          }));

        // 任务账本快照：状态分布 + 明细。
        const statusCounts: Record<string, number> = {};
        for (const t of tasks) statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1;
        const taskDetails = tasks.map((t) => ({
          id: t.id,
          title: t.title,
          room: t.room,
          status: t.status,
          assignee: t.assignee ?? null,
          rounds: t.rounds,
          max_rounds: t.maxRounds ?? null,
          touched_paths: t.touched,
        }));

        // 事件游标 + 黑板 blocked 免责索引：逐房间独立打开日志读末笔 seq
        // （不经单写者缓存的 log()）；同时收集该房间黑板分片的 blocked 角色
        // （#97 ADR 0016：任一分片 blocked 即豁免 stale——等待输入非停摆）。
        const eventCursors: Array<{ room: string; seq: number }> = [];
        const blockedIndex = new Map<string, boolean>();
        if (existsSync(l.roomsDir)) {
          for (const room of readdirSync(l.roomsDir)) {
            try {
              const el = new EventLog(join(l.roomsDir, room, "events.jsonl"));
              await el.init();
              const { events } = await el.read();
              const last = events[events.length - 1];
              eventCursors.push({ room, seq: last?.seq ?? 0 });
            } catch {
              // 房间目录存在但事件文件不可读：游标记 0
              eventCursors.push({ room, seq: 0 });
            }
            try {
              for (const shard of await listShards(teamHome, room)) {
                if (shard.status === "blocked") blockedIndex.set(shard.role, true);
              }
            } catch {
              // 黑板不可读按无免责数据处理（罕见 fs 异常路径；report-only
              // 输出宁缺勿滥，不做二次兜底读）。
            }
          }
        }

        // stale 心跳标注（#97，ADR 0016，report-only）：阈值与判定规则见
        // types.ts STALE_THRESHOLD_MS（严格大于；dead 一律不收录——lost 着色
        // 已表达防双计；tier0 主控不入名册，其静默独立走 master_idle 单项，
        // 消除自刷矛盾与 reconcile 全员可调的续命放大通道；仅 status=running
        // 的成员参与标注——spawned/stopped 非干活中；超阈且黑板任一分片
        // blocked 者归 awaiting_input 免责档（等待输入 ≠ 停摆，避免误标触发
        // 误干预）。时钟回拨致负 age 时天然不超阈，无需特判。
        const now = Date.now();
        const heartbeatCandidates = members.filter(
          (m) => m.tier !== 0 && m.status === "running" && Number.isFinite(m.lastSeen),
        );
        const isOverThreshold = (m: MemberRecord): boolean =>
          now - m.lastSeen > STALE_THRESHOLD_MS;
        const formatStale = (m: MemberRecord): { member: string; last_seen_age_ms: number } => ({
          member: m.member,
          last_seen_age_ms: now - m.lastSeen,
        });
        const byNameAsc = (
          a: { member: string },
          b: { member: string },
        ): number => a.member.localeCompare(b.member);
        const stale_members = heartbeatCandidates
          .filter((m) => isOverThreshold(m) && blockedIndex.get(m.member) !== true)
          .map(formatStale)
          .sort(byNameAsc);
        const awaiting_input = heartbeatCandidates
          .filter((m) => isOverThreshold(m) && blockedIndex.get(m.member) === true)
          .map(formatStale)
          .sort(byNameAsc);
        const tier0Master = members.find((m) => m.tier === 0);
        const master_idle =
          tier0Master !== undefined &&
          Number.isFinite(tier0Master.lastSeen) &&
          now - tier0Master.lastSeen > STALE_THRESHOLD_MS;

        const overview = {
          initialized: snapshot !== null,
          snapshot: snapshot && {
            name: snapshot.name ?? null,
            source: snapshot.source ?? null,
            digest: snapshot.digest ?? null,
            playbook_digest: snapshot.playbook_digest ?? null,
            instantiated_at: snapshot.instantiated_at ?? null,
          },
          members: memberLedger,
          dangling_assignees,
          orphan_members,
          // 互斥冲突标注（#137，report-only）：findConflicts 对当前账本全量
          // running 任务对按 room + mutexGroups/touched 判定；空数组合法态
          // 恒输出——固定输出 schema 供契约测试断言（ADR 0015 先例）。
          active_mutex_conflicts: findConflicts(tasks),
          master_idle,
          stale_members,
          awaiting_input,
          task_status_counts: statusCounts,
          tasks: taskDetails,
          event_cursors: eventCursors,
          goal_binding: "framework-invisible; run get_goal to verify",
          tool_manifest_pointer: "see framework tool manifest section of the boot message",
        };

        if (scope === "overview") return { ok: true, scope, ...overview };

        // scope=audit：旁路 report-only。扫描根只取快照持久化的工作区。
        const workspace =
          snapshot && typeof snapshot.workspace === "string" ? snapshot.workspace : null;
        const registeredPaths = tasks.flatMap((t) => t.touched ?? []);
        const report = auditWorkspace(workspace, registeredPaths);
        return { ok: true, scope, overview, audit: report };
      } catch (error) {
        wrap(error);
      }
    },

  };
}
