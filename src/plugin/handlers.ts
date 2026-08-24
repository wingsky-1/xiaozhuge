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
import type { TaskRecord, TaskStatus } from "../runtime/types.js";
import { ensureDir } from "../runtime/fs-utils.js";
import { layout } from "../runtime/paths.js";
import { Ledger, findConflicts } from "../runtime/ledger.js";
import { EventLog } from "../runtime/event-log.js";
import { Registry } from "../runtime/registry.js";
import { getShard, listShards, setShard } from "../runtime/blackboard.js";
import { acknowledge, claim, deliver, readUnread } from "../runtime/mailbox.js";
import { acquireCas } from "../runtime/cas-lock.js";

/** 统一错误形状：{ error: { code, message } }，模型可读可路由。 */
export class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

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

/** 一个团队实例的 handler 集（绑定到某主会话的 TEAM_HOME）。 */
export interface Handlers {
  /** team_init：建目录结构 + agents.json 骨架 + room.lock 幂等占位。 */
  init: (args: Record<string, unknown>) => Promise<unknown>;
  /** team_spawn：登记成员 durable id 入 agents.json。 */
  spawn: (args: Record<string, unknown>) => Promise<unknown>;
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
        await appendEvent("system", "team/init", { instance_note: args.instance_note ?? null, lock: outcome });
        return { ok: true, lock: outcome, home: l.teamHome };
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
