/**
 * Wave 1a（#120 v2 计划 1e）：工具面 handler 绑定反查后的跨会话数据通道。
 *
 * 主控侧 handlers 创建实例 + dispatch 给成员 dur-X；子代理侧 handlers（以
 * resolveTeamHomeForView("dur-X").teamHome 构造）能认领主控侧信封、task_update
 * 落主控账本可被 task_list 读到。DSH_HOME 环境隔离。
 *
 * 同时覆盖 agentless 抛错（复核必改 3）与 host.execute 反查接线。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../../src/plugin/host.js";
import { createHandlers, memberCaller, rootCaller, type Handlers } from "../../src/plugin/handlers.js";
import { resolveTeamHome, resolveTeamHomeForView } from "../../src/plugin/team-home.js";
import { resetSessionIndex } from "../../src/plugin/session-index.js";

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

afterEach(() => {
  // 反查索引单例按 DSH_HOME 隔离；逐用例清理防 fd/状态累积（ADR 0021）。
  resetSessionIndex();
});

describe("Wave 1a 工具面反查挂载（子代理 → 主控实例）", () => {
  it("子代理侧 handlers 认领主控侧信封并落主控账本", async () => {
    // 主控侧：实例根 + 任务 + dispatch。
    const masterHome = resolveTeamHome(SESSION_MASTER);
    const master = createHandlers(masterHome, SESSION_MASTER, rootCaller());
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
    const sub = createHandlers(resolution.teamHome, DUR_X, memberCaller(MEMBER));

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
    await createHandlers(resolveTeamHome(SESSION_MASTER), SESSION_MASTER, rootCaller()).init({});
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

  it("子代理未登记首调不缓存空解析，主控登记后自愈命中（独立审核发现）", async () => {
    const { registered } = makeHost();
    await createHandlers(resolveTeamHome(SESSION_MASTER), SESSION_MASTER, rootCaller()).init({});
    // 子代理 dur-q1 尚未被主控登记：首调反查未命中 → 走自身逻辑根，不炸，
    // 但不得把空解析写入 handlerCache。
    const before = (await registered.get("team_task_list")!.execute(
      {},
      { agent: { id: DUR_X } },
    )) as { ok: boolean; tasks: unknown[] };
    expect(before.ok).toBe(true);
    expect(before.tasks).toEqual([]);
    // 主控侧建任务 + dispatch 登记 dur-q1 并派发信封。
    const created = (await registered.get("team_task_create")!.execute(
      { title: "t", room: "root" },
      { agent: { id: SESSION_MASTER } },
    )) as { ok: boolean; task_id: string };
    await registered.get("team_dispatch")!.execute(
      { member: MEMBER, durable_id: DUR_X, role: MEMBER, tier: 1, task_id: created.task_id },
      { agent: { id: SESSION_MASTER } },
    );
    // 子代理再次调用：应重新解析并命中主控实例，读到主控派发的信封。
    const after = (await registered.get("team_inbox")!.execute(
      { member: MEMBER },
      { agent: { id: DUR_X } },
    )) as { ok: boolean; unread: Array<{ id: string }> };
    expect(after.ok).toBe(true);
    expect(after.unread).toHaveLength(1);
  });
});

describe("Wave 1b 写面收敛矩阵（#123）", () => {
  /** 主控 init + 建任务 + dispatch 给 qa，返回 { master, sub, taskId }。 */
  async function makeTeam() {
    const masterHome = resolveTeamHome(SESSION_MASTER);
    const master = createHandlers(masterHome, SESSION_MASTER, rootCaller());
    await master.init({});
    const created = (await master.taskCreate({ title: "t", room: "root" })) as {
      ok: true;
      task_id: string;
    };
    await master.dispatch({
      member: MEMBER,
      durable_id: DUR_X,
      role: MEMBER,
      tier: 1,
      task_id: created.task_id,
    });
    const sub = createHandlers(masterHome, DUR_X, memberCaller(MEMBER));
    return { master, sub, taskId: created.task_id };
  }

  it("子代理越权：spawn/dispatch/taskCreate → forbidden", async () => {
    const { sub } = await makeTeam();
    await expect(
      sub.spawn({ member: "coder", durable_id: "d2", role: "coder", tier: 1 }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      sub.dispatch({ member: "coder", durable_id: "d2", role: "coder", tier: 1, task_id: "x" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      sub.taskCreate({ title: "x", room: "root" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("子代理越权：send from 他人 / inbox 他人 / ack 他人 / stateSet 他人分片 → forbidden", async () => {
    const { sub } = await makeTeam();
    await expect(
      sub.send({ to: "coder", from: "master", type: "info", body: { n: 1 } }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(sub.inbox({ member: "coder" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      sub.ack({ member: "coder", envelope_id: "env-1" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      sub.stateSet({ room: "root", role: "coder", status: "running" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("子代理越权：taskUpdate 他人任务 / 自己任务 patch assignee / handoff 他人任务 → forbidden", async () => {
    const { master, sub, taskId } = await makeTeam();
    // 他人任务：master 再建一个未指派任务（assignee 缺省），子代理无权更新。
    const other = (await master.taskCreate({ title: "other", room: "root" })) as {
      ok: true;
      task_id: string;
    };
    await expect(
      sub.taskUpdate({ task_id: other.task_id, status: "running" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    // 自己任务 patch assignee（绕过 handoff 回执）→ forbidden。
    await expect(
      sub.taskUpdate({ task_id: taskId, status: "running", assignee: "qa" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    // handoff 他人任务 → forbidden。
    await expect(
      sub.handoff({ task_id: other.task_id, to_role: "qa", receipt: ["pass: done"] }),
    ).rejects.toMatchObject({ code: "forbidden" });
    // handoff 自己任务但 to_role 未登记 → unknown-member（防 dangling assignee）。
    await expect(
      sub.handoff({ task_id: taskId, to_role: "ghost", receipt: ["pass: done"] }),
    ).rejects.toMatchObject({ code: "unknown-member" });
  });

  it("未登记会话（caller undefined）写操作 → forbidden", async () => {
    const home = resolveTeamHome("session-ghost");
    const ghost = createHandlers(home, "session-ghost", undefined);
    await expect(
      ghost.stateSet({ room: "root", role: "qa", status: "running" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("host.execute 端到端：子代理写操作 forbidden、未登记会话写操作 forbidden、子代理合法流可达", async () => {
    const { registered } = makeHost();
    await createHandlers(resolveTeamHome(SESSION_MASTER), SESSION_MASTER, rootCaller()).init({});
    // 主控建任务 + dispatch 登记 dur-q1。
    const created = (await registered.get("team_task_create")!.execute(
      { title: "t", room: "root" },
      { agent: { id: SESSION_MASTER } },
    )) as { ok: boolean; task_id: string };
    await registered.get("team_dispatch")!.execute(
      { member: MEMBER, durable_id: DUR_X, role: MEMBER, tier: 1, task_id: created.task_id },
      { agent: { id: SESSION_MASTER } },
    );
    // 子代理经 execute：spawn / taskCreate / send-from-他人 → forbidden。
    await expect(
      registered.get("team_spawn")!.execute(
        { member: "coder", durable_id: "d2", role: "coder", tier: 1 },
        { agent: { id: DUR_X } },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      registered.get("team_task_create")!.execute(
        { title: "x", room: "root" },
        { agent: { id: DUR_X } },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      registered.get("team_send")!.execute(
        { to: "master", from: "master", type: "info", body: { n: 1 } },
        { agent: { id: DUR_X } },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    // 子代理经 execute 合法流：inbox 自己 + taskUpdate 自己任务可达。
    const inbox = (await registered.get("team_inbox")!.execute(
      { member: MEMBER },
      { agent: { id: DUR_X } },
    )) as { ok: boolean; unread: Array<{ id: string }> };
    expect(inbox.ok).toBe(true);
    await expect(
      registered.get("team_task_update")!.execute(
        { task_id: created.task_id, status: "running", rounds: 1 },
        { agent: { id: DUR_X } },
      ),
    ).resolves.toMatchObject({ ok: true });
    // 未登记会话经 execute：写操作 forbidden。
    await expect(
      registered.get("team_task_create")!.execute(
        { title: "x", room: "root" },
        { agent: { id: "dur-ghost" } },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("子代理合法流：inbox 自己 / ack 自己 / taskUpdate 自己任务 / stateSet 自己分片 / send from 自己 / handoff 自己任务", async () => {
    const { sub, taskId } = await makeTeam();
    // inbox 自己的未读信封并认领。
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
    // ack 自己的信封。
    await expect(
      sub.ack({ member: MEMBER, envelope_id: envelopeId }),
    ).resolves.toMatchObject({ ok: true });
    // taskUpdate 自己持有的任务（dispatch 后 assignee=qa）。
    await expect(
      sub.taskUpdate({ task_id: taskId, status: "running", rounds: 1 }),
    ).resolves.toMatchObject({ ok: true, status: "running" });
    // stateSet 自己的分片。
    await expect(
      sub.stateSet({ room: "root", role: MEMBER, status: "running" }),
    ).resolves.toMatchObject({ ok: true });
    // send from 自己。
    await expect(
      sub.send({ to: "master", from: MEMBER, type: "info", body: { n: 1 } }),
    ).resolves.toMatchObject({ ok: true });
    // handoff 自己持有的任务（qa 是 master 之外需先登记——dispatch 已登记 qa；
    // to_role 用已登记的 qa 自交回）。
    await expect(
      sub.handoff({ task_id: taskId, to_role: "qa", receipt: ["pass: done"] }),
    ).resolves.toMatchObject({ ok: true, assignee: "qa" });
  });
});