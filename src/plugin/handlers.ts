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
  acquireCas,
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

/** 一个团队实例的 handler 集（绑定到某主会话的 TEAM_HOME）。 */
export interface Handlers {
  /** team_init：建目录结构 + agents.json 骨架 + room.lock 幂等占位。 */
  init: (args: Record<string, unknown>) => Promise<unknown>;
  /** team_spawn：登记成员 durable id 入 agents.json。 */
  spawn: (args: Record<string, unknown>) => Promise<unknown>;
  /** team_dispatch（ADR 0015，#67）：spawn → 指派 → 派单复合原语，半事务。 */
  dispatch: (args: Record<string, unknown>) => Promise<unknown>;
  /** team_send：定向信箱投递（可达性 = 注册表存在性，MVP auto 模式）。 */
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
  /** team_reconcile（ADR 0015）：对账全量视图 / scope=audit 旁路 report-only。 */
  reconcile: (args: Record<string, unknown>) => Promise<unknown>;
}

export function createHandlers(teamHome: string, sessionId: string): Handlers {
  const l = layout(teamHome);
  let ledger: Ledger | undefined;
  let events: EventLog | undefined;
  let registry: Registry | undefined;

  // 惰性单例：同一实例根内复用事件游标等内存状态。
  function led(): Ledger {
    return (ledger ??= new Ledger(teamHome, l.ledgerTasksDir));
  }
  function log(room: string): EventLog {
    // 同房间单写者约定下缓存游标；不同房间各自独立文件。
    return (events ??= new EventLog(join(l.roomsDir, room, "events.jsonl")));
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
            ...(inline !== undefined ? { role_inline: inline } : {}),
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
              role_inline: inline ?? null,
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
        const type = reqStr(args, "type");
        const body = args.body ?? null;
        if ((await reg().getMember(to)) === undefined) {
          throw new ToolError("unknown-member", `recipient ${to} is not registered`);
        }
        const envelopeId = await deliver(teamHome, to, { from, type, body });
        // 计账增补 task_id（若 body 为对象且携带）：对账时「哪封信对应哪个任务」
        // 不必再开信封比对，机械可得。
        const rawTaskId = (body as { task_id?: unknown }).task_id;
        const bodyTaskId =
          body !== null && typeof body === "object" && typeof rawTaskId === "string" && rawTaskId.length > 0
            ? rawTaskId
            : undefined;
        await appendEvent(from, "mailbox/deliver", {
          to,
          envelope_id: envelopeId,
          msg_type: type,
          ...(bodyTaskId !== undefined ? { task_id: bodyTaskId } : {}),
        });
        return { ok: true, envelope_id: envelopeId };
      } catch (error) {
        wrap(error);
      }
    },

    async inbox(args) {
      try {
        const member = reqStr(args, "member");
        const uuid = optStr(args, "envelope_id");
        if (uuid !== undefined) {
          const claimed = await claim(teamHome, member, uuid);
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
        const uuid = reqStr(args, "envelope_id");
        await acknowledge(teamHome, member, uuid);
        await appendEvent(member, "mailbox/ack", { envelope_id: uuid });
        return { ok: true };
      } catch (error) {
        wrap(error);
      }
    },

    async taskCreate(args) {
      try {
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
        const status = optStr(args, "status");
        const rounds = optNum(args, "rounds");
        const expectRev = optNum(args, "expect_rev");
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
          { ...(expectRev !== undefined ? { expectRev } : {}) },
        );
        await appendEvent(updated.assignee ?? "system", "task/update", {
          task_id: taskId,
          status: updated.status,
          rev: updated.rev,
        });
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
        const status = reqStr(args, "status");
        const ext = args.ext;
        const shard = await setShard(teamHome, room, role, {
          status: status as Parameters<typeof setShard>[3]["status"],
          ...(ext !== undefined ? { ext } : {}),
        });
        await appendEvent(role, "blackboard/set", { room, status: shard.status });
        return { ok: true, role, status: shard.status };
      } catch (error) {
        wrap(error);
      }
    },

    async handoff(args) {
      try {
        const taskId = reqStr(args, "task_id");
        const toRole = reqStr(args, "to_role");
        const receipt = optStrArray(args, "receipt");
        const task = await led().get(taskId);
        if (task === undefined) throw new ToolError("task-not-found", `task ${taskId} does not exist`);
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
        const updated = await led().update(taskId, {
          assignee: toRole,
          ...(task.status === "blocked" ? { status: "running" as TaskStatus } : {}),
        });
        await appendEvent(toRole, "handoff", { task_id: taskId, to_role: toRole, receipt: receipt ?? null });
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
        const byAssignee = new Map<string, string[]>();
        for (const t of tasks) {
          if (t.assignee === undefined) continue;
          byAssignee.set(t.assignee, [...(byAssignee.get(t.assignee) ?? []), t.id]);
        }
        const memberLedger = members.map((m) => ({
          member: m.member,
          durable_id: m.durableId,
          tier: m.tier,
          parent: m.parent ?? null,
          status: m.status,
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

        // 事件游标：逐房间独立打开日志读末笔 seq（不经单写者缓存的 log()）。
        const eventCursors: Array<{ room: string; seq: number }> = [];
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
          }
        }

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
