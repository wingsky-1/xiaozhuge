/**
 * Wave 1a（#120 v2 计划 1e）：工具面 handler 绑定反查后的跨会话数据通道。
 *
 * 主控侧 handlers 创建实例 + dispatch 给成员 dur-X；子代理侧 handlers（以
 * resolveTeamHomeForView("dur-X").teamHome 构造）能认领主控侧信封、task_update
 * 落主控账本可被 task_list 读到。DSH_HOME 环境隔离。
 *
 * 同时覆盖 agentless 抛错（复核必改 3）与 host.execute 反查接线。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../../src/plugin/host.js";
import { createHandlers, type Handlers } from "../../src/plugin/handlers.js";
import { resolveTeamHome, resolveTeamHomeForView } from "../../src/plugin/team-home.js";

const SESSION_MASTER = "session-master-1";
const MEMBER = "qa";
const DUR_X = "dur-q1";

/** 轻量工具类型，用于 host.execute 断言的松散签名。 */
interface Tool {
  execute: (args: Record<string, unknown>, exec?: { agent?: { id?: string } }) => Promise<unknown>;
}

function makeHost() {
  const registered = new Map<string, Tool>();
  const ctx = {
    tools: {
      register: (d: { name: string }) => {
        registered.set(d.name, d as unknown as Tool);
        return () => registered.delete(d.name);
      },
    },
    logger: { info: () => {}, warn: () => {} },
    get: () => undefined,
  };
  const dispose = apply(ctx as never);
  return { registered, dispose };
}

let dshHome: string;

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "xzg-hosttools-"));
  dshHome = join(home, "dsh-home");
  process.env.DSH_HOME = dshHome;
});

describe("Wave 1a 工具面反查挂载（子代理 → 主控实例）", () => {
  it("子代理侧 handlers 认领主控侧信封并落主控账本", async () => {
    // 主控侧：实例根 + 任务 + dispatch。
    const masterHome = resolveTeamHome(SESSION_MASTER);
    const master = createHandlers(masterHome, SESSION_MASTER);
    await master.init({});
    const created = (await master.taskCreate({ title: "t", room: "root" })) as {
      ok: true;
      task_id: string;
    };
    const taskId = created.task_id;
    await master.dispatch({
      member: MEMBER,
      durable_id: DUR_X,
      role: MEMBER,
      tier: 1,
      task_id: taskId,
    });

    // 子代理侧：反查挂载主控实例根。
    const resolution = resolveTeamHomeForView(DUR_X);
    expect(resolution.membership).toEqual({ root_session: SESSION_MASTER, member: MEMBER });
    expect(resolution.teamHome).toBe(masterHome);
    const sub = createHandlers(resolution.teamHome, DUR_X);

    // inbox 读到主控侧派发信封并可认领。
    const unread = (await sub.inbox({ member: MEMBER })) as {
      ok: true;
      unread: Array<{ id: string }>;
    };
    expect(unread.unread).toHaveLength(1);
    const envelopeId = unread.unread[0]!.id;
    const claimed = (await sub.inbox({ member: MEMBER, envelope_id: envelopeId })) as {
      ok: true;
      envelope: { id: string };
    };
    expect(claimed.envelope.id).toBe(envelopeId);

    // 子代理 task_update 落主控账本：主控侧 task_list 可读。
    const updated = (await sub.taskUpdate({ task_id: taskId, status: "running", rounds: 1 })) as {
      ok: true;
      status: string;
    };
    expect(updated.status).toBe("running");
    const list = (await master.taskList({})) as {
      ok: true;
      tasks: Array<{ id: string; status: string }>;
    };
    const task = list.tasks.find((t) => t.id === taskId);
    expect(task?.status).toBe("running");
  });

  it("host.execute 子代理侧反查接主控实例（L51 接线验证）", async () => {
    const { registered } = makeHost();
    // 建主控实例态。
    await createHandlers(resolveTeamHome(SESSION_MASTER), SESSION_MASTER).init({});
    // 主控侧建任务 + dispatch。
    const created = (await registered.get("team_task_create")!.execute(
      { title: "t", room: "root" },
      { agent: { id: SESSION_MASTER } },
    )) as { ok: boolean; task_id: string };
    const taskId = created.task_id;
    await registered.get("team_dispatch")!.execute(
      { member: MEMBER, durable_id: DUR_X, role: MEMBER, tier: 1, task_id: taskId },
      { agent: { id: SESSION_MASTER } },
    );
    // 子代理侧以 dur-q1 身份 inbox 读到主控派发信封。
    const inbox = (await registered.get("team_inbox")!.execute(
      { member: MEMBER },
      { agent: { id: DUR_X } },
    )) as { ok: boolean; unread: Array<{ id: string }> };
    expect(inbox.unread).toHaveLength(1);
    // 子代理侧 task_update 落主控账本。
    await registered.get("team_task_update")!.execute(
      { task_id: taskId, status: "running", rounds: 1 },
      { agent: { id: DUR_X } },
    );
    // 主控侧 task_list 读回 running。
    const list = (await registered.get("team_task_list")!.execute(
      {},
      { agent: { id: SESSION_MASTER } },
    )) as { ok: boolean; tasks: Array<{ id: string; status: string }> };
    const task = list.tasks.find((t) => t.id === taskId);
    expect(task?.status).toBe("running");
  });

  it("agentless 调用抛稳定错误码 agent-required（复核必改 3）", async () => {
    const { registered } = makeHost();
    await expect(
      registered.get("team_task_list")!.execute({}, { agent: undefined }),
    ).rejects.toMatchObject({ code: "agent-required" });
  });
});