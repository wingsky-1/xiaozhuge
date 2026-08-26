/**
 * golden 调用集：场景 → 期望工具调用序列 + 期望状态迁移（issue #7）。
 * 函数级重放：直接驱动 createHandlers 的 handler，逐项核对工具返回与
 * 账本/信箱/事件流状态。负路径（非法迁移/越权发送/互斥冲突）一并入集。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandlers, type Handlers } from "../../src/plugin/handlers.js";
import { EventLog } from "../../src/runtime/kernel/event-log.js";
import { layout } from "../../src/runtime/kernel/paths.js";
import { readUnread } from "../../src/runtime/collab/mailbox.js";

let home: string;
let handlers: Handlers;
const SESSION = "session-golden-1";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "xzg-golden-"));
  handlers = createHandlers(home, SESSION);
});

async function readEvents(room = "root"): Promise<Array<{ type: string; actor: string; seq: number }>> {
  const log = new EventLog(join(layout(home).roomsDir, room, "events.jsonl"));
  await log.init();
  const { events } = await log.read();
  return events.map((e) => ({ type: e.type, actor: e.actor, seq: e.seq }));
}

describe("golden 场景一：init → spawn → task 全链路", () => {
  it("单任务全流程：create→running→handoff→done，事件与账本逐项核对", async () => {
    // 1. init
    expect(await handlers.init({})).toMatchObject({ ok: true, lock: "acquired" });
    expect(existsSync(layout(home).agentsJson)).toBe(true);
    expect(existsSync(layout(home).gatesDir)).toBe(true);
    expect(existsSync(layout(home).teamYaml)).toBe(true);

    // 2. spawn coder 与 qa（coder → qa 拓扑，保证 handoff 有对象）
    expect(
      await handlers.spawn({ member: "coder", durable_id: "dur-coder", role: "coder", tier: 1 }),
    ).toEqual({ ok: true, member: "coder", durable_id: "dur-coder" });
    await handlers.spawn({ member: "qa", durable_id: "dur-qa", role: "qa", tier: 1 });

    // 3. 建任务（带 dod）
    const created = (await handlers.taskCreate({
      title: "实现 X",
      room: "root",
      assignee: "coder",
      max_rounds: 3,
      dod: ["build 绿"],
    })) as { ok: true; task_id: string; status: string };
    expect(created.status).toBe("queued");

    // 4. 非法迁移直接被拒（queued → done 不合法）
    await expect(
      handlers.taskUpdate({ task_id: created.task_id, status: "done" }),
    ).rejects.toMatchObject({ code: "illegal-transition" });

    // 5. 合法流转 running
    const running = (await handlers.taskUpdate({
      task_id: created.task_id,
      status: "running",
    })) as { rev: number };
    expect(running.status).toBe("running");

    // 6. 带 dod 的 handoff 必须附回执；回执条数不足即拒
    await expect(handlers.handoff({ task_id: created.task_id, to_role: "qa" })).rejects.toMatchObject({
      code: "receipt-required",
    });
    await expect(
      handlers.handoff({ task_id: created.task_id, to_role: "qa", receipt: [] }),
    ).rejects.toMatchObject({ code: "receipt-incomplete" });
    // 6.1 逐条结论格式校验（#98 步骤 2）：非 pass:/fail: 开头即拒
    await expect(
      handlers.handoff({
        task_id: created.task_id,
        to_role: "qa",
        receipt: ["构建通过所以没问题了"],
      }),
    ).rejects.toMatchObject({ code: "receipt-format" });
    const handed = (await handlers.handoff({
      task_id: created.task_id,
      to_role: "qa",
      receipt: ["pass: build 绿"],
    })) as { assignee: string };
    expect(handed.assignee).toBe("qa");

    // 7. qa 收尾 done
    const done = (await handlers.taskUpdate({
      task_id: created.task_id,
      status: "done",
      artifact: "archive/x.md",
    })) as { status: string };
    expect(done.status).toBe("done");

    // 8. 事件流逐项核对（副作用自动落账）
    const evs = await readEvents();
    expect(evs.map((e) => e.type)).toEqual([
      "team/init",
      "team/spawn",
      "team/spawn",
      "task/create",
      "task/update",
      "handoff",
      "task/update",
    ]);

    // 9. 账本终态核对
    const list = (await handlers.taskList({})) as { tasks: Array<{ status: string; artifact?: string }> };
    expect(list.tasks[0]?.status).toBe("done");
    expect(list.tasks[0]?.artifact).toBe("archive/x.md");
  });
});

describe("golden 场景二：send/inbox 信箱协作", () => {
  it("投递→认领→确认，越权发送被拒", async () => {
    await handlers.init({});
    await handlers.spawn({ member: "coder", durable_id: "d1", role: "coder", tier: 1 });
    await handlers.spawn({ member: "qa", durable_id: "d2", role: "qa", tier: 1 });

    // 未注册成员不可达
    await expect(handlers.send({ to: "ghost", from: "master", type: "info", body: {} })).rejects.toMatchObject({
      code: "unknown-member",
    });

    const sent = (await handlers.send({
      to: "coder",
      from: "master",
      type: "task-assign",
      body: { task: "x" },
    })) as { envelope_id: string };

    const inbox = (await handlers.inbox({ member: "coder" })) as {
      unread: Array<{ id: string; body: unknown }>;
    };
    expect(inbox.unread.map((e) => e.id)).toContain(sent.envelope_id);

    const claimed = (await handlers.inbox({ member: "coder", envelope_id: sent.envelope_id })) as {
      envelope: { body: unknown };
    };
    expect(claimed.envelope.body).toEqual({ task: "x" });

    await handlers.ack({ member: "coder", envelope_id: sent.envelope_id });
    // ack 后 unread 清空
    expect(((await handlers.inbox({ member: "coder" })) as { unread: unknown[] }).unread).toHaveLength(0);

    // 事件留痕
    const evs = await readEvents();
    expect(evs.filter((e) => e.type === "mailbox/deliver")).toHaveLength(1);
    expect(evs.filter((e) => e.type === "mailbox/ack")).toHaveLength(1);
  });
});

describe("golden 场景三：黑板读写与非法值全拒", () => {
  it("state_set 保留态强制 + state_get 读回", async () => {
    await handlers.stateSet({ room: "root", role: "coder", status: "running", ext: { note: "working" } });
    const shard = (await handlers.stateGet({ room: "root", role: "coder" })) as {
      shard: { status: string; ext: unknown };
    };
    expect(shard.shard.status).toBe("running");
    expect(shard.shard.ext).toEqual({ note: "working" });
    await expect(
      handlers.stateSet({ room: "root", role: "coder", status: "review" }),
    ).rejects.toMatchObject({ code: "invalid-stage" });
    const all = (await handlers.stateGet({ room: "root" })) as { shards: unknown[] };
    expect(all.shards).toHaveLength(1);
  });
});

describe("golden 场景四：参数校验负矩阵", () => {
  it("缺必填参数给稳定 code", async () => {
    await expect(handlers.send({ from: "a", type: "t", body: null })).rejects.toMatchObject({
      code: "invalid-arguments",
    });
    await expect(handlers.taskCreate({ room: "r" })).rejects.toMatchObject({
      code: "invalid-arguments",
    });
    await expect(handlers.stateSet({ room: "r", role: "a" })).rejects.toMatchObject({
      code: "invalid-arguments",
    });
  });

  it("互斥冲突：同 touched path 的 running 任务拒绝新建", async () => {
    await handlers.init({});
    const t1 = (await handlers.taskCreate({
      title: "A",
      room: "root",
      touched_paths: ["src/a.ts"],
      mutex_groups: ["core"],
    })) as { task_id: string };
    await handlers.taskUpdate({ task_id: t1.task_id, status: "running" });
    await expect(
      handlers.taskCreate({
        title: "B",
        room: "root",
        touched_paths: ["src/a.ts"],
      }),
    ).rejects.toMatchObject({ code: "mutex-conflict" });
  });
});

describe("golden 场景五：team_dispatch 复合派发（ADR 0015）", () => {
  it("dispatch 一步完成 spawn→assign→send，事件流与信封逐项核对", async () => {
    await handlers.init({});
    const created = (await handlers.taskCreate({ title: "派发 X", room: "root" })) as {
      task_id: string;
    };
    const result = (await handlers.dispatch({
      member: "coder",
      durable_id: "dur-coder",
      role: "coder",
      tier: 1,
      task_id: created.task_id,
      model: "strong-model",
      role_inline: { briefing: "按 dod 执行" },
    })) as { ok: boolean; steps: string[]; envelope_id: string };
    expect(result.ok).toBe(true);
    expect(result.steps).toEqual(["spawn", "assign", "send"]);

    // 成员账本对照：注册表在场 + 任务已指派。
    const list = (await handlers.taskList({})) as {
      tasks: Array<{ id: string; assignee?: string }>;
    };
    expect(list.tasks[0]?.assignee).toBe("coder");

    // 信封：任务与 inline 定义、模型档位随单投递。
    const unread = await readUnread(home, "coder");
    expect(unread).toHaveLength(1);
    expect(unread[0]).toMatchObject({
      type: "task-assign",
      body: {
        task_id: created.task_id,
        title: "派发 X",
        model: "strong-model",
        role_inline: { briefing: "按 dod 执行" },
      },
    });
    expect(unread[0]!.id).toBe(result.envelope_id);

    // 事件流：三步各一笔。
    const evs = await readEvents();
    expect(evs.map((e) => e.type)).toEqual([
      "team/init",
      "task/create",
      "team/spawn",
      "task/update",
      "mailbox/deliver",
    ]);
  });

  it("半事务：rev 冲突停在 assign 前，spawn 已留痕", async () => {
    await handlers.init({});
    const created = (await handlers.taskCreate({ title: "A", room: "root" })) as {
      task_id: string;
    };
    await handlers.taskUpdate({ task_id: created.task_id, rounds: 1 });
    await expect(
      handlers.dispatch({
        member: "qa",
        durable_id: "dur-qa",
        role: "qa",
        tier: 1,
        task_id: created.task_id,
        expect_rev: 1,
      }),
    ).rejects.toMatchObject({ code: "rev-conflict" });
    const evs = await readEvents();
    expect(evs.map((e) => e.type)).toEqual(["team/init", "task/create", "task/update", "team/spawn"]);
    const list = (await handlers.taskList({})) as {
      tasks: Array<{ id: string; assignee?: string }>;
    };
    expect(list.tasks[0]?.assignee).toBeUndefined();
  });
});
