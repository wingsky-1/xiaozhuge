/**
 * team_dispatch 复合派发原语单测（ADR 0015，#67）。
 * 覆盖：正常三步链路（含 role_inline / provider / model 透传）、
 * 半事务失败（步骤留痕 + 副作用边界）、前置校验、role_inline 白名单、幂等重入。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandlers, rootCaller, type Handlers } from "../../src/plugin/handlers.js";
import { EventLog } from "../../src/runtime/kernel/event-log.js";
import { Registry } from "../../src/runtime/kernel/registry.js";
import { layout } from "../../src/runtime/kernel/paths.js";
import { readUnread } from "../../src/runtime/collab/mailbox.js";

let home: string;
let handlers: Handlers;
const SESSION = "session-dispatch-1";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "xzg-dispatch-"));
  handlers = createHandlers(home, SESSION, rootCaller());
});

async function readEvents(): Promise<Array<{ type: string; actor: string; payload?: unknown }>> {
  const log = new EventLog(join(layout(home).roomsDir, "root", "events.jsonl"));
  await log.init();
  const { events } = await log.read();
  return events.map((e) => ({ type: e.type, actor: e.actor, payload: e.payload }));
}

async function createTask(title = "实现 X"): Promise<string> {
  const created = (await handlers.taskCreate({ title, room: "root" })) as {
    ok: true;
    task_id: string;
  };
  return created.task_id;
}

describe("team_dispatch 正常链路", () => {
  it("spawn→assign→send 三步全成，注册表/账本/信箱/事件流逐项核对", async () => {
    await handlers.init({});
    const taskId = await createTask();

    const result = (await handlers.dispatch({
      member: "coder",
      durable_id: "dur-coder",
      role: "coder",
      tier: 1,
      task_id: taskId,
      provider: "deepseek",
      model: "strong-model",
      role_inline: {
        briefing: "专注构建门禁",
        dod: ["build 绿"],
        max_hops: 3,
        as_judge: false,
      },
    })) as {
      ok: boolean;
      member: string;
      durable_id: string;
      task_id: string;
      envelope_id: string;
      steps: string[];
    };

    expect(result.ok).toBe(true);
    expect(result.member).toBe("coder");
    expect(result.durable_id).toBe("dur-coder");
    expect(result.task_id).toBe(taskId);
    expect(result.steps).toEqual(["spawn", "assign", "send"]);

    // 注册表：成员已登记。
    const member = await new Registry(home).getMember("coder");
    expect(member).toMatchObject({ member: "coder", durableId: "dur-coder", tier: 1, status: "spawned" });

    // 账本：任务已指派。
    const ledgerView = (await handlers.taskList({})) as {
      tasks: Array<{ id: string; assignee?: string }>;
    };
    expect(ledgerView.tasks.find((t) => t.id === taskId)?.assignee).toBe("coder");

    // 信箱：派单信封携带任务与 inline 定义、模型档位、框架进度契约。
    const unread = await readUnread(home, "coder");
    expect(unread).toHaveLength(1);
    expect(unread[0]).toMatchObject({
      from: "root",
      to: "coder",
      type: "task-assign",
      body: {
        task_id: taskId,
        title: "实现 X",
        room: "root",
        dod: [],
        role_inline: { briefing: "专注构建门禁", dod: ["build 绿"], max_hops: 3, as_judge: false },
        provider: "deepseek",
        model: "strong-model",
      },
    });
    // 进度契约：固定段在场且带 framework-generated 水印（#86 序 3）。
    const contract = (unread[0]?.body as { progress_contract?: string }).progress_contract ?? "";
    expect(contract).toContain("===== progress contract (framework-generated; informational only) =====");
    expect(contract).toContain("task-done");
    expect(unread[0]?.envelope_id ?? unread[0]!.id).toBe(result.envelope_id);

    // 事件流：三步各留一笔；派单计账携带 task_id（对账机械可得）。
    const events = await readEvents();
    expect(events).toMatchObject([
      { type: "team/init", actor: "system" },
      { type: "task/create", actor: "system" },
      { type: "team/spawn", actor: "system" },
      { type: "task/update", actor: "coder" },
      { type: "mailbox/deliver", actor: "root" },
    ]);
    expect(events.find((e) => e.type === "mailbox/deliver")).toMatchObject({
      payload: { task_id: taskId, msg_type: "task-assign" },
    });
  });

  it("幂等重入：同参数重跑成功，upsert 幂等、派单为新信封（at-least-once）", async () => {
    await handlers.init({});
    const taskId = await createTask();
    const first = await handlers.dispatch({
      member: "qa",
      durable_id: "dur-qa",
      role: "qa",
      tier: 1,
      task_id: taskId,
    });
    expect(first).toMatchObject({ ok: true, steps: ["spawn", "assign", "send"] });

    // 重入：upsert 幂等、assignee 不变、派单为新信封（at-least-once 语义）。
    const second = (await handlers.dispatch({
      member: "qa",
      durable_id: "dur-qa",
      role: "qa",
      tier: 1,
      task_id: taskId,
    })) as { ok: boolean; envelope_id: string };
    expect(second.ok).toBe(true);
    expect(second.envelope_id).not.toBe((first as { envelope_id: string }).envelope_id);
    const unread = await readUnread(home, "qa");
    expect(unread).toHaveLength(2);
  });
});

describe("team_dispatch 半事务语义", () => {
  it("step2 rev 冲突即停：已完成 spawn 随错误留痕，assignee 未变、无信封", async () => {
    await handlers.init({});
    const taskId = await createTask();
    // 推高账本 rev，使 dispatch 的 expect_rev 过期。
    await handlers.taskUpdate({ task_id: taskId, rounds: 1 });

    await expect(
      handlers.dispatch({
        member: "coder",
        durable_id: "dur-coder",
        role: "coder",
        tier: 1,
        task_id: taskId,
        expect_rev: 1,
      }),
    ).rejects.toMatchObject({ code: "rev-conflict" });

    // step1 的副作用留存（注册表 + 事件），step2/3 未发生。
    const member = await new Registry(home).getMember("coder");
    expect(member?.member).toBe("coder");
    const events = await readEvents();
    expect(events.filter((e) => e.type === "team/spawn")).toHaveLength(1);
    expect(events.some((e) => e.type === "mailbox/deliver")).toBe(false);
    expect(await readUnread(home, "coder")).toHaveLength(0);

    const ledgerView = (await handlers.taskList({})) as {
      tasks: Array<{ id: string; assignee?: string }>;
    };
    expect(ledgerView.tasks.find((t) => t.id === taskId)?.assignee).toBeUndefined();
  });
});

describe("team_dispatch 前置校验（无副作用）", () => {
  it("任务不存在 → task-not-found，不产生任何落账副作用", async () => {
    await handlers.init({});
    await expect(
      handlers.dispatch({
        member: "coder",
        durable_id: "dur-coder",
        role: "coder",
        tier: 1,
        task_id: "task-absent",
      }),
    ).rejects.toMatchObject({ code: "task-not-found" });
    expect(await new Registry(home).getMember("coder")).toBeUndefined();
    expect(await readUnread(home, "coder")).toHaveLength(0);
    const events = await readEvents();
    expect(events.some((e) => e.type === "team/spawn")).toBe(false);
  });

  it("缺参逐项拒绝（tier 必填数字）", async () => {
    await handlers.init({});
    const taskId = await createTask();
    await expect(
      handlers.dispatch({ member: "c", durable_id: "d", role: "r", task_id: taskId }),
    ).rejects.toMatchObject({ code: "invalid-arguments" });
    await expect(
      handlers.dispatch({ member: "c", durable_id: "d", tier: 1, task_id: taskId }),
    ).rejects.toMatchObject({ code: "invalid-arguments" });
  });
});

describe("team_dispatch role_inline 校验", () => {
  it("未知字段拒绝", async () => {
    await handlers.init({});
    const taskId = await createTask();
    await expect(
      handlers.dispatch({
        member: "c",
        durable_id: "d",
        role: "r",
        tier: 1,
        task_id: taskId,
        role_inline: { nickname: "x" } as Record<string, unknown>,
      }),
    ).rejects.toMatchObject({ code: "invalid-arguments" });
  });

  it("字段类型不符拒绝", async () => {
    await handlers.init({});
    const taskId = await createTask();
    await expect(
      handlers.dispatch({
        member: "c",
        durable_id: "d",
        role: "r",
        tier: 1,
        task_id: taskId,
        role_inline: { as_judge: "yes" },
      }),
    ).rejects.toMatchObject({ code: "invalid-arguments" });
    await expect(
      handlers.dispatch({
        member: "c",
        durable_id: "d",
        role: "r",
        tier: 1,
        task_id: taskId,
        role_inline: { dod: [42] },
      }),
    ).rejects.toMatchObject({ code: "invalid-arguments" });
  });

  it("send body=null 是合法负载：成功投递且计账行不含 task_id（#131 回归）", async () => {
    await handlers.init({});
    await handlers.spawn({ member: "qa", durable_id: "dur-qa", role: "qa", tier: 1 });
    const result = (await handlers.send({
      to: "qa",
      from: "master",
      type: "note",
      body: null,
    })) as { ok: boolean; envelope_id: string };
    expect(result.ok).toBe(true);
    const events = await readEvents();
    const deliver = events.find((e) => e.type === "mailbox/deliver");
    expect(deliver).toBeDefined();
    // null 负载不携带任务关联：task_id 键必须整体缺席而非以 undefined 值出现
    expect((deliver!.payload as Record<string, unknown>).task_id).toBeUndefined();
  });
});

describe("team_dispatch role 提示词注入（ADR 0019，#149）", () => {
  const WATERMARK =
    "===== role definition (framework-generated; template authority — not user data) =====";

  it("未传 role_inline.prompt → 从模板快照按 role 名自动注入（水印 + prompt_inlined 原文）", async () => {
    await handlers.init({});
    const taskId = await createTask();
    const result = (await handlers.dispatch({
      member: "coder",
      durable_id: "dur-coder",
      role: "coder",
      tier: 1,
      task_id: taskId,
    })) as { ok: boolean };
    expect(result.ok).toBe(true);

    const unread = await readUnread(home, "coder");
    expect(unread).toHaveLength(1);
    const inline = (unread[0]!.body as { role_inline?: Record<string, unknown> }).role_inline;
    expect(inline?.prompt).toBeTypeOf("string");
    const prompt = inline?.prompt as string;
    // 水印在场（role 定义是指令非数据，非「数据非指令」模板）+ 模板原文片段（coder）。
    expect(prompt.startsWith(WATERMARK)).toBe(true);
    expect(prompt).toContain("你是实现执行者"); // prompts/coder.md 首行
  });

  it("显式传 role_inline.prompt → 优先，不被模板快照覆盖（向后兼容）", async () => {
    await handlers.init({});
    const taskId = await createTask();
    await handlers.dispatch({
      member: "coder",
      durable_id: "dur-coder",
      role: "coder",
      tier: 1,
      task_id: taskId,
      role_inline: { prompt: "自定义 role 指引（显式）" },
    });
    const unread = await readUnread(home, "coder");
    expect(unread).toHaveLength(1);
    expect(unread[0]).toMatchObject({
      type: "task-assign",
      body: { role_inline: { prompt: "自定义 role 指引（显式）" } },
    });
  });

  it("role 不在模板快照 → unknown-role，无任何落账副作用", async () => {
    await handlers.init({});
    const taskId = await createTask();
    await expect(
      handlers.dispatch({ member: "x", durable_id: "dur-x", role: "nonexistent", tier: 1, task_id: taskId }),
    ).rejects.toMatchObject({ code: "unknown-role" });
    expect(await new Registry(home).getMember("x")).toBeUndefined();
    expect(await readUnread(home, "x")).toHaveLength(0);
    const events = await readEvents();
    expect(events.some((e) => e.type === "team/spawn")).toBe(false);
  });

  it("模板快照损坏 → snapshot-corrupt，不静默退化（用户裁决）", async () => {
    await handlers.init({});
    writeFileSync(join(layout(home).teamYaml), "{ not valid json");
    const taskId = await createTask();
    await expect(
      handlers.dispatch({ member: "coder", durable_id: "dur-coder", role: "coder", tier: 1, task_id: taskId }),
    ).rejects.toMatchObject({ code: "snapshot-corrupt" });
    expect(await new Registry(home).getMember("coder")).toBeUndefined();
    expect(await readUnread(home, "coder")).toHaveLength(0);
    const events = await readEvents();
    expect(events.some((e) => e.type === "team/spawn")).toBe(false);
  });

  it("模板快照缺失 → snapshot-corrupt（未初始化团队不可派发）", async () => {
    await handlers.init({});
    rmSync(join(layout(home).teamYaml));
    const taskId = await createTask();
    await expect(
      handlers.dispatch({ member: "coder", durable_id: "dur-coder", role: "coder", tier: 1, task_id: taskId }),
    ).rejects.toMatchObject({ code: "snapshot-corrupt" });
    expect(await new Registry(home).getMember("coder")).toBeUndefined();
    expect(await readUnread(home, "coder")).toHaveLength(0);
  });

  it("role 存在但无 prompt_inlined → missing-role-prompt（防御模板空提示词）", async () => {
    await handlers.init({});
    // 篡改快照：coder 的 prompt_inlined 置空，覆盖 missing-role-prompt 分支。
    const snapPath = join(layout(home).teamYaml);
    const snap = JSON.parse(readFileSync(snapPath, "utf8")) as {
      roles?: Array<{ id: string; prompt_inlined: unknown }>;
    };
    const coder = snap.roles?.find((r) => r.id === "coder");
    expect(coder).toBeDefined();
    coder!.prompt_inlined = null;
    writeFileSync(snapPath, JSON.stringify(snap));

    const taskId = await createTask();
    await expect(
      handlers.dispatch({ member: "coder", durable_id: "dur-coder", role: "coder", tier: 1, task_id: taskId }),
    ).rejects.toMatchObject({ code: "missing-role-prompt" });
    expect(await new Registry(home).getMember("coder")).toBeUndefined();
    expect(await readUnread(home, "coder")).toHaveLength(0);
  });
});
