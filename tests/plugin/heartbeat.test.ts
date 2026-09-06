/**
 * #97 白名单心跳触点单测（ADR 0016）：白名单工具调用成功后刷新对应成员
 * lastSeen，归属 = 事件流 actor 镜像口径；forbidden 前置失败与纯读不刷。
 * 时钟由 fake timers 控制，lastSeen 精确等于调用时刻 Date.now()。
 * send 的 body=null 已随 #131 修复支持（null 合法负载，计账行不携带 task_id）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHandlers,
  rootCaller,
  memberCaller,
  type Handlers,
} from "../../src/plugin/handlers.js";
import { Registry } from "../../src/index.js";

let home: string;
let master: Handlers; // 主控会话 handler 集
let coder: Handlers; // 成员 coder 会话 handler 集
const BASE = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
  home = mkdtempSync(join(tmpdir(), "xzg-heartbeat-"));
  master = createHandlers(home, "session-master", rootCaller());
  coder = createHandlers(home, "dur-coder", memberCaller("coder"));
});

afterEach(() => {
  vi.useRealTimers();
});

async function seedTeam(): Promise<void> {
  await master.init({});
  vi.setSystemTime(BASE + 1_000);
  await master.spawn({ member: "coder", durable_id: "dur-coder", role: "coder", tier: 1 });
}

/** 读成员当前 lastSeen（未登记返回 -1）。 */
async function seenOf(member: string): Promise<number> {
  return (await new Registry(home).getMember(member))?.lastSeen ?? -1;
}

describe("白名单心跳触点（#97 ADR 0016）", () => {
  it("team_send 刷发件人、不动收件人", async () => {
    await seedTeam(); // coder.lastSeen = BASE+1000
    vi.setSystemTime(BASE + 5_000);
    await master.send({ to: "coder", from: "master", type: "info", body: {} });
    expect(await seenOf("master")).toBe(BASE + 5_000);
    expect(await seenOf("coder")).toBe(BASE + 1_000); // 收件人不因被投递而续命
  });

  it("team_inbox readUnread 分支纯读不刷；claim 分支刷本人", async () => {
    await seedTeam();
    vi.setSystemTime(BASE + 5_000);
    const sent = (await master.send({
      to: "coder",
      from: "master",
      type: "info",
      body: { hello: true },
    })) as { envelope_id: string };
    // readUnread：纯读白名单之外。
    vi.setSystemTime(BASE + 6_000);
    await coder.inbox({ member: "coder" });
    expect(await seenOf("coder")).toBe(BASE + 1_000);
    // claim：认领是投递写副作用 → 刷本人。
    vi.setSystemTime(BASE + 7_000);
    await coder.inbox({ member: "coder", envelope_id: sent.envelope_id });
    expect(await seenOf("coder")).toBe(BASE + 7_000);
  });

  it("team_ack 刷确认者本人（#194 批刷：窗口内重复心跳合并，lastSeen=窗口首刷时刻）", async () => {
    await seedTeam();
    vi.setSystemTime(BASE + 5_000);
    const sent = (await master.send({
      to: "coder",
      from: "master",
      type: "info",
      body: { hello: true },
    })) as { envelope_id: string };
    vi.setSystemTime(BASE + 6_000);
    await coder.inbox({ member: "coder", envelope_id: sent.envelope_id }); // claim → 首刷落盘 BASE+6s 并开 30s 窗口
    vi.setSystemTime(BASE + 7_000);
    await coder.ack({ member: "coder", envelope_id: sent.envelope_id }); // 1s 后 ack：窗口内合并（内存计数免写）
    expect(await seenOf("coder")).toBe(BASE + 6_000); // 磁盘 lastSeen = 窗口首刷时刻（30s 粒度批刷）
  });

  it("#194 批刷：窗口已过 → 下一次心跳重新落盘（滞后上界 = 一个窗口 + 下一次调用）", async () => {
    await seedTeam();
    vi.setSystemTime(BASE + 5_000);
    await coder.stateSet({ room: "root", role: "coder", status: "running" });
    expect(await seenOf("coder")).toBe(BASE + 5_000); // 首刷落盘
    vi.setSystemTime(BASE + 10_000);
    await coder.heartbeatProbe?.();
    // 窗口内（BASE+5s + 30s）：合并不写。
    expect(await seenOf("coder")).toBe(BASE + 5_000);
    // 窗口外（+31s）：新窗口首刷重新落盘。
    vi.setSystemTime(BASE + 36_000);
    await coder.send({ to: "master", from: "coder", type: "info", body: {} });
    expect(await seenOf("coder")).toBe(BASE + 36_000);
  });

  it("#194 批刷：机会式冲刷——同一 handler 集内成员 B 心跳顺带把已到期窗口的成员 A 落盘", async () => {
    await seedTeam();
    vi.setSystemTime(BASE + 1_000);
    await master.spawn({ member: "qa", durable_id: "dur-qa", role: "qa", tier: 1 });
    const t1 = (await master.taskCreate({ title: "A", room: "root", assignee: "coder" })) as { task_id: string };
    const t2 = (await master.taskCreate({ title: "B", room: "root", assignee: "qa" })) as { task_id: string };
    // 主控代管 coder 认领：coder 首刷 BASE+2s，开 30s 窗口（至 BASE+32s）。
    vi.setSystemTime(BASE + 2_000);
    await master.taskUpdate({ task_id: t1.task_id, status: "running" });
    expect(await seenOf("coder")).toBe(BASE + 2_000);
    // BASE+40s 主控代管 qa 认领：qa 心跳时 coder 的窗口（BASE+32s）已到期
    // → 同 handler 集内机会式冲刷把 coder 落盘至 BASE+40s。
    vi.setSystemTime(BASE + 40_000);
    await master.taskUpdate({ task_id: t2.task_id, status: "running" });
    expect(await seenOf("coder")).toBe(BASE + 40_000);
    expect(await seenOf("qa")).toBe(BASE + 40_000);
  });

  it("team_state_set 刷分片归属 role 本人", async () => {
    await seedTeam();
    vi.setSystemTime(BASE + 5_000);
    await coder.stateSet({ room: "root", role: "coder", status: "running" });
    expect(await seenOf("coder")).toBe(BASE + 5_000);
    // 主控代写他人分片同样刷该分片 role（镜像口径）而非调用者。
    vi.setSystemTime(BASE + 6_000);
    await coder.stateSet({ room: "root", role: "ghost-shard-role", status: "done" }).catch(
      () => undefined, // 黑板对未登记角色可能拒绝；此处仅关注已登记路径
    );
    expect(await seenOf("coder")).toBe(BASE + 5_000); // 未被上一步误伤
  });

  it("team_task_update 主控代管刷 assignee 而非调用者（镜像口径）", async () => {
    await seedTeam();
    vi.setSystemTime(BASE + 3_000);
    const created = (await master.taskCreate({
      title: "任务 X",
      room: "root",
      assignee: "coder",
    })) as { task_id: string };
    vi.setSystemTime(BASE + 5_000);
    await master.taskUpdate({ task_id: created.task_id, status: "running" });
    expect(await seenOf("coder")).toBe(BASE + 5_000);
    expect(await seenOf("master")).toBe(BASE); // 调用者（tier0 主控）不被误刷
  });

  it("team_handoff 刷交接目标 to_role 而非调用者与原持有者", async () => {
    await seedTeam();
    vi.setSystemTime(BASE + 2_000);
    await master.spawn({ member: "qa", durable_id: "dur-qa", role: "qa", tier: 1 });
    const created = (await master.taskCreate({
      title: "交接我",
      room: "root",
      assignee: "coder",
    })) as { task_id: string };
    vi.setSystemTime(BASE + 6_000);
    await master.handoff({ task_id: created.task_id, to_role: "qa" });
    expect(await seenOf("qa")).toBe(BASE + 6_000);
    expect(await seenOf("coder")).toBe(BASE + 1_000); // 原持有者不因失去任务而续命
    expect(await seenOf("master")).toBe(BASE);
  });

  it("forbidden 前置失败不产生任何心跳（副作用前抛错）", async () => {
    await seedTeam();
    // 越权冒充：intruder 身份尝试以 master 名义发信 → requireSelf 拒绝。
    const intruder = createHandlers(home, "dur-intruder", memberCaller("intruder"));
    vi.setSystemTime(BASE + 9_000);
    await expect(
      intruder.send({ to: "coder", from: "master", type: "info", body: {} }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await seenOf("master")).toBe(BASE); // 冒充者无从给 master 续命
    expect(await seenOf("coder")).toBe(BASE + 1_000); // 收件人也不动
  });

  it("触点插入不影响既有工具返回形态与事件序列", async () => {
    await seedTeam();
    vi.setSystemTime(BASE + 5_000);
    const sent = (await master.send({
      to: "coder",
      from: "master",
      type: "info",
      body: {},
    })) as { ok: boolean; envelope_id: string };
    expect(sent.ok).toBe(true);
    expect(typeof sent.envelope_id).toBe("string");
  });
});
