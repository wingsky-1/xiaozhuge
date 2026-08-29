/**
 * Q6（#150）成员状态机：agents.json 状态迁移由框架事件副作用驱动。
 * 覆盖：认领→running、全部完成→stopped、多任务保持 running、阻塞申报→blocked、
 * 恢复→running、同态幂等（不重复 member/status 事件）。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandlers, rootCaller, type Handlers } from "../../src/plugin/handlers.js";
import { EventLog } from "../../src/runtime/kernel/event-log.js";
import { Registry } from "../../src/runtime/kernel/registry.js";
import { layout } from "../../src/runtime/kernel/paths.js";

let home: string;
let handlers: Handlers;
const SESSION = "session-member-status";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "xzg-status-"));
  handlers = createHandlers(home, SESSION, rootCaller());
});

async function readEvents(): Promise<Array<{ type: string; actor: string; payload?: unknown }>> {
  const log = new EventLog(join(layout(home).roomsDir, "root", "events.jsonl"));
  await log.init();
  const { events } = await log.read();
  return events.map((e) => ({ type: e.type, actor: e.actor, payload: e.payload }));
}

async function createTask(title = "任务 X"): Promise<string> {
  const created = (await handlers.taskCreate({ title, room: "root" })) as {
    ok: true;
    task_id: string;
  };
  return created.task_id;
}

/** 以成员身份调用的 handler 实例（requireSelf/requireHolder 通过）。 */
function memberHandlers(member: string): Handlers {
  return createHandlers(home, SESSION, { kind: "member", member } as const);
}

async function seedCoder(): Promise<void> {
  await handlers.spawn({ member: "coder", durable_id: "dur-coder", role: "coder", tier: 1 });
}

describe("Q6 成员状态机（#150）", () => {
  it("认领任务（taskUpdate running）→ 成员状态 running + member/status 事件留痕", async () => {
    await handlers.init({});
    await seedCoder();
    const taskId = await createTask();
    await handlers.taskUpdate({ task_id: taskId, assignee: "coder" });
    await memberHandlers("coder").taskUpdate({ task_id: taskId, status: "running" });

    expect((await new Registry(home).getMember("coder"))?.status).toBe("running");
    const events = await readEvents();
    expect(events.find((e) => e.type === "member/status")).toMatchObject({
      actor: "system",
      payload: { member: "coder", from: "spawned", to: "running" },
    });
  });

  it("全部任务完成 → 成员状态 stopped（无其他活动任务）", async () => {
    await handlers.init({});
    await seedCoder();
    const taskId = await createTask();
    await handlers.taskUpdate({ task_id: taskId, assignee: "coder" });
    await memberHandlers("coder").taskUpdate({ task_id: taskId, status: "running" });
    await memberHandlers("coder").taskUpdate({ task_id: taskId, status: "done" });

    expect((await new Registry(home).getMember("coder"))?.status).toBe("stopped");
    const events = await readEvents();
    const toStopped = events.find(
      (e) => e.type === "member/status" && (e.payload as { to?: string })?.to === "stopped",
    );
    expect(toStopped).toBeDefined();
    expect(toStopped).toMatchObject({ payload: { from: "running", to: "stopped" } });
  });

  it("仍有其他活动任务 → 完成一个不降级 stopped（保持 running）", async () => {
    await handlers.init({});
    await seedCoder();
    const t1 = await createTask();
    const t2 = await createTask();
    await handlers.taskUpdate({ task_id: t1, assignee: "coder" });
    await handlers.taskUpdate({ task_id: t2, assignee: "coder" });
    await memberHandlers("coder").taskUpdate({ task_id: t1, status: "running" });
    await memberHandlers("coder").taskUpdate({ task_id: t2, status: "running" });
    await memberHandlers("coder").taskUpdate({ task_id: t1, status: "done" });

    expect((await new Registry(home).getMember("coder"))?.status).toBe("running");
    const events = await readEvents();
    expect(events.some((e) => (e.payload as { to?: string })?.to === "stopped")).toBe(false);
  });

  it("黑板阻塞申报 → 成员 blocked；恢复申报 → running", async () => {
    await handlers.init({});
    await seedCoder();
    await memberHandlers("coder").stateSet({ room: "root", role: "coder", status: "blocked" });
    expect((await new Registry(home).getMember("coder"))?.status).toBe("blocked");
    expect((await readEvents()).find((e) => e.type === "member/status")).toMatchObject({
      payload: { from: "spawned", to: "blocked" },
    });

    await memberHandlers("coder").stateSet({ room: "root", role: "coder", status: "running" });
    expect((await new Registry(home).getMember("coder"))?.status).toBe("running");
  });

  it("同态幂等：重复阻塞申报不重复 member/status 事件", async () => {
    await handlers.init({});
    await seedCoder();
    await memberHandlers("coder").stateSet({ room: "root", role: "coder", status: "blocked" });
    // 第二次同态申报：transitMemberStatus 幂等跳过，不重复留痕
    // （任务状态机本身禁止 running→running，故幂等路径走黑板申报验证）。
    await memberHandlers("coder").stateSet({ room: "root", role: "coder", status: "blocked" });

    const events = await readEvents();
    expect(events.filter((e) => e.type === "member/status")).toHaveLength(1);
  });
});
