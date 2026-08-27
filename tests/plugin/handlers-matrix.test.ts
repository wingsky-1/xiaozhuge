/**
 * team_* handler 参数校验穷举矩阵：对每个 handler 的每个必填键，
 * 断言缺失时的稳定错误码与精确消息文本；可选字段的类型违规逐一覆盖。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandlers, rootCaller, type Handlers } from "../../src/plugin/handlers.js";

let home: string;
let h: Handlers;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "xzg-hm-"));
  h = createHandlers(home, "session-hm", rootCaller());
});

/** 对每个 handler 枚举必填键：缺任一键即 invalid-arguments + 精确消息。 */
const requiredMatrix: Array<{
  handler: keyof Handlers;
  setup?: () => Promise<void>;
  all: Record<string, string>; // 全部合法最小参数（值任意占位）
  stringRequired: string[];
  numberRequired?: string[];
}> = [
  {
    handler: "spawn",
    all: { member: "m", durable_id: "d", role: "r", tier: 1 },
    stringRequired: ["member", "durable_id", "role"],
    numberRequired: ["tier"],
  },
  {
    handler: "send",
    all: { to: "qa", from: "master", type: "info", body: null },
    stringRequired: ["to", "from", "type"],
    setup: async () => {},
  },
  { handler: "inbox", all: { member: "coder" }, stringRequired: ["member"] },
  { handler: "ack", all: { member: "coder", envelope_id: "e1" }, stringRequired: ["member", "envelope_id"] },
  { handler: "taskCreate", all: { title: "t", room: "root" }, stringRequired: ["title", "room"] },
  { handler: "taskUpdate", all: { task_id: "t1" }, stringRequired: ["task_id"] },
  { handler: "stateGet", all: { room: "root" }, stringRequired: ["room"] },
  { handler: "stateSet", all: { room: "root", role: "a", status: "running" }, stringRequired: ["room", "role", "status"] },
  { handler: "handoff", all: { task_id: "t1", to_role: "qa" }, stringRequired: ["task_id", "to_role"] },
];

describe("必填参数缺失矩阵", () => {
  for (const entry of requiredMatrix) {
    for (const key of entry.stringRequired) {
      it(`${String(entry.handler)}: 缺 ${key}`, async () => {
        if (entry.setup) await entry.setup();
        const args = { ...entry.all };
        delete args[key];
        await expect((h[entry.handler] as (a: object) => Promise<unknown>)(args)).rejects.toMatchObject({
          code: "invalid-arguments",
          message: `string field "${key}" is required`,
        });
      });
    }
    for (const key of entry.numberRequired ?? []) {
      it(`${String(entry.handler)}: 缺数值 ${key}`, async () => {
        const args = { ...entry.all };
        delete args[key];
        await expect((h[entry.handler] as (a: object) => Promise<unknown>)(args)).rejects.toMatchObject({
          code: "invalid-arguments",
          message: 'number field "tier" is required',
        });
      });
    }
  }
});

describe("可选字段类型违规矩阵", () => {
  const base = { member: "m", durable_id: "d", role: "r", tier: 1 };

  it("spawn.tier 非数字", async () => {
    await expect(h.spawn({ ...base, tier: "1" })).rejects.toMatchObject({
      code: "invalid-arguments",
      message: 'field "tier" must be a number',
    });
  });

  it("taskCreate.touched_paths 非字符串数组", async () => {
    await expect(
      h.taskCreate({ title: "t", room: "r", touched_paths: "src/a.ts" }),
    ).rejects.toMatchObject({ code: "invalid-arguments", message: 'field "touched_paths" must be a string array' });
  });

  it("taskCreate.dod 含非字符串元素", async () => {
    await expect(
      h.taskCreate({ title: "t", room: "r", dod: [1, 2] }),
    ).rejects.toMatchObject({ code: "invalid-arguments", message: 'field "dod" must be a string array' });
  });

  it("taskUpdate.rounds 非数字", async () => {
    const t = await (h.taskCreate({ title: "t", room: "r" }) as unknown as Promise<{ task_id: string }>);
    await expect(
      h.taskUpdate({ task_id: t.task_id, rounds: "many" }),
    ).rejects.toMatchObject({ code: "invalid-arguments", message: 'field "rounds" must be a number' });
  });

  it("stateSet.status 非保留态给 invalid-stage", async () => {
    await expect(h.stateSet({ room: "r", role: "a", status: "paused" })).rejects.toMatchObject({
      code: "invalid-stage",
    });
  });

  it("send.to 未注册成员给 unknown-member", async () => {
    await expect(h.send({ to: "ghost", from: "master", type: "info", body: null })).rejects.toMatchObject({
      code: "unknown-member",
      message: "recipient ghost is not registered",
    });
  });

  it("handoff 任务不存在给 task-not-found", async () => {
    await expect(h.handoff({ task_id: "nope", to_role: "qa" })).rejects.toMatchObject({
      code: "task-not-found",
      message: "task nope does not exist",
    });
  });
});
