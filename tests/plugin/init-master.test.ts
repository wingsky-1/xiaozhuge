/**
 * init 预登记 tier0 主控单测（#79 L1）。
 * 覆盖：主控入册（member=tiers[0].id、durableId=宿主会话 id、status=running）、
 * 返回值 master_member、team/init 事件载荷并入（不另发 spawn 事件）、
 * 同会话重入幂等、同名异 durableId 注册被拒（member-conflict）。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandlers, type Handlers } from "../../src/plugin/handlers.js";
import { Registry } from "../../src/runtime/kernel/registry.js";
import { EventLog } from "../../src/runtime/kernel/event-log.js";
import { layout } from "../../src/runtime/kernel/paths.js";

let home: string;
let handlers: Handlers;
const SESSION = "session-init-master-1";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "xzg-init-master-"));
  handlers = createHandlers(home, SESSION);
});

async function readEvents(): Promise<Array<{ type: string; payload: unknown }>> {
  const log = new EventLog(join(layout(home).roomsDir, "root", "events.jsonl"));
  await log.init();
  const { events } = await log.read();
  return events.map((e) => ({ type: e.type, payload: e.payload }));
}

describe("init 预登记 tier0 主控（#79）", () => {
  it("init 即入册：member=tiers[0].id、durableId=会话 id、status=running，返回 master_member", async () => {
    const result = (await handlers.init({})) as { ok: boolean; master_member?: string };
    expect(result.ok).toBe(true);
    // builtin 默认场景 oss-maintenance 的 tiers[0].id 即 "master"。
    expect(result.master_member).toBe("master");
    const master = await new Registry(home).getMember("master");
    expect(master).toMatchObject({
      tier: 0,
      parent: null,
      durableId: SESSION,
      status: "running",
    });
    // 并入 team/init 载荷，不另发 spawn 事件（保持事件类型序列契约稳定）。
    const events = await readEvents();
    expect(events.filter((e) => e.type === "team/spawn")).toHaveLength(0);
    expect(events[0]?.type).toBe("team/init");
    expect(events[0]?.payload).toMatchObject({ master: { member: "master", outcome: "registered" } });
  });

  it("同会话重入幂等：注册表仍单条 master，事件载荷 outcome=idempotent", async () => {
    await handlers.init({});
    await handlers.init({});
    const reg = await new Registry(home).read();
    expect(Object.keys(reg.members)).toEqual(["master"]);
    const events = await readEvents();
    const payloads = events.filter((e) => e.type === "team/init").map((e) => e.payload);
    expect(payloads[1]).toMatchObject({ master: { outcome: "idempotent" } });
  });

  it("同名异 durableId 注册被拒（member-conflict）；接管路径先标 dead 后可复位", async () => {
    await handlers.init({});
    await expect(
      handlers.spawn({ member: "master", durable_id: "dur-new", role: "master", tier: 1 }),
    ).rejects.toMatchObject({ code: "member-conflict" });
    // 模拟接管核对把旧记录标 dead 后，新身份即可入册。
    const registry = new Registry(home);
    await registry.setStatus("master", "dead");
    await expect(
      handlers.spawn({ member: "master", durable_id: "dur-new", role: "master", tier: 1 }),
    ).resolves.toMatchObject({ ok: true });
  });
});
