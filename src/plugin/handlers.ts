/**
 * team_* 工具 handler 工厂：纯逻辑层，不依赖 cordis。
 * golden 调用集直接驱动本层断言「工具返回 + 账本/信箱/事件流状态迁移」；
 * 宿主装配层（host.ts）把它包装成 ToolDefinition。
 *
 * 一切校验委托 P2a/P2b 纯库；本层只做参数装配与错误文案包装
 * （定稿 G0 边界：确定性操作在工具内部完成，LLM 只做决策）。
 */
import { mkdirSync } from "node:fs";
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
  acquireCas,
} from "../runtime/index.js";
import { userTemplatesRoot, projectTemplatesRoot } from "./team-home.js";

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
        await writeJsonAtomic(l.teamYaml, instantiateSnapshot(loaded, playbook.digest));
        await appendEvent("system", "team/init", { instance_note: args.instance_note ?? null, lock: outcome });
        const tier0PromptPath = (loaded.template.tiers as Array<{ prompt?: string }>)[0]?.prompt ?? "";
        const scenarioPrompt = loaded.prompts[tier0PromptPath] ?? "";
        return {
          ok: true,
          lock: outcome,
          home: l.teamHome,
          scenario,
          source: scenarioSource,
          tier0_prompt: assembleTier0Prompt(playbook, scenarioPrompt),
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
        await reg().upsertMember({
          member,
          durableId,
          tier,
          status: "spawned",
          lastSeen: Date.now(),
        });
        await appendEvent("system", "team/spawn", { member, durable_id: durableId, role, tier });
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
          // step 1: 注册（幂等 upsert，与 team_spawn 同一落账函数）。
          await ensureDir(join(l.mailboxDir, member));
          await reg().upsertMember({
            member,
            durableId,
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
          // step 3: 派单信封（role_inline 与模型档位随信封投递给成员）。
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
            },
          });
          await appendEvent(from, "mailbox/deliver", {
            to: member,
            envelope_id: envelopeId,
            msg_type: "task-assign",
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
        await appendEvent(from, "mailbox/deliver", { to, envelope_id: envelopeId, msg_type: type });
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
        if (receipt !== undefined && receipt.length < task.dod.length) {
          throw new ToolError(
            "receipt-incomplete",
            `dod has ${task.dod.length} items but receipt has ${receipt.length} conclusions`,
          );
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
  };
}
