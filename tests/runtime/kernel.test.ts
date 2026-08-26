import { describe, expect, it, vi } from "vitest";
// 将 node:fs/promises 导出替换为透传 spy（可 mockRejectedValueOnce 注入单次
// 失败），不改真实行为；仅本次测试使用。
vi.mock("node:fs/promises", { spy: true });
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireCas,
  canTransition,
  confineToRoot,
  discardRunningSentinels,
  ensureDir,
  findConflicts,
  layout,
  peekLock,
  Ledger,
  LedgerError,
  listGates,
  openGate,
  readGate,
  EventLog,
  readJson,
  recoverDeliveries,
  releaseCas,
  resolveGate,
  roomLayout,
  Registry,
  GateError,
  LockConflictError,
  sweepTmp,
  TASK_STATUSES,
  withCasLock,
  writeJsonAtomic,
} from "../../src/index.js";
import type { MemberRecord } from "../../src/runtime/kernel/types.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "xzg-p2a-"));
}

describe("状态机", () => {
  it("合法迁移放行", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "blocked")).toBe(true);
    expect(canTransition("blocked", "running")).toBe(true);
    expect(canTransition("running", "done")).toBe(true);
    expect(canTransition("queued", "cancelled")).toBe(true);
  });

  it("非法迁移拒绝（含终态）", () => {
    expect(canTransition("done", "running")).toBe(false);
    expect(canTransition("cancelled", "queued")).toBe(false);
    expect(canTransition("queued", "done")).toBe(false);
    expect(canTransition("blocked", "done")).toBe(false);
  });
});

describe("fs-utils 原子写", () => {
  it("writeJsonAtomic 落位后可读回且无临时残片", async () => {
    const home = tmpHome();
    const file = join(home, "nested", "data.json");
    await writeJsonAtomic(file, { a: 1 });
    expect(await readJson(file)).toEqual({ a: 1 });
    const entries = await import("node:fs/promises").then((m) => m.readdir(join(home, "nested")));
    expect(entries.filter((e) => e.startsWith(".tmp-"))).toEqual([]);
    // 库残片形态（<target>.<digest>）同样不应存在
    expect(entries.filter((e) => e.includes(".json.") && !e.endsWith(".json"))).toEqual([]);
  });

  it("sweepTmp 清扫两类临时残片并返回数量", async () => {
    const home = tmpHome();
    await ensureDir(home);
    writeFileSync(join(home, ".tmp-x-1-2"), "{}");
    writeFileSync(join(home, "data.json.aB3dEf9gH2j"), "{}");
    writeFileSync(join(home, "keep.json"), "{}");
    writeFileSync(join(home, "notes.md"), "x");
    mkdirSync(join(home, "dir.json.not-a-file"), { recursive: true }); // 目录残片不计数不误删
    expect(await sweepTmp(home)).toBe(2);
    expect(existsSync(join(home, ".tmp-x-1-2"))).toBe(false);
    expect(existsSync(join(home, "data.json.aB3dEf9gH2j"))).toBe(false);
    expect(await sweepTmp(home)).toBe(0);
    expect(existsSync(join(home, "keep.json"))).toBe(true);
    expect(existsSync(join(home, "notes.md"))).toBe(true);
    expect(existsSync(join(home, "dir.json.not-a-file"))).toBe(true);
  });

  it("confineToRoot 拒绝越界目标", () => {
    const root = "/tmp/team-home/archive";
    expect(confineToRoot(root, "run-log.md")).toContain("/tmp/team-home/archive/");
    expect(() => confineToRoot(root, "../escape.md")).toThrow(/escapes/);
  });
});

describe("CAS 锁", () => {
  it("首次获取 acquired，同实例重入 reentered", async () => {
    const home = tmpHome();
    const lock = join(home, "room");
    expect(await acquireCas(lock, "sess-1")).toBe("acquired");
    expect(await acquireCas(lock, "sess-1")).toBe("reentered");
    expect(existsSync(join(home, "room.lock"))).toBe(true); // 锁形态：目录
  });

  it("异实例持有冲突，错误携带当前 holder；peekLock 可诊断", async () => {
    const lock = join(tmpHome(), "room");
    await acquireCas(lock, "sess-A");
    expect(await peekLock(lock)).toMatchObject({ holder: "sess-A" });
    try {
      await acquireCas(lock, "sess-B");
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(LockConflictError);
      expect((error as Error).message).toContain("sess-A");
    }
    await releaseCas(lock, "sess-B").catch((e: unknown) => {
      // 非持有者释放必须被拒
      expect(e).toBeInstanceOf(LockConflictError);
    });
  });

  it("release 后可被他人获取；幂等清理不抛", async () => {
    const lock = join(tmpHome(), "room");
    await acquireCas(lock, "sess-A");
    await releaseCas(lock, "sess-A");
    expect(await acquireCas(lock, "sess-B")).toBe("acquired");
    await releaseCas(lock, "sess-B");
    await releaseCas(lock, "sess-B"); // 幂等：已不存在
  });

  it("孤儿锁（无有效 owner）默认拒绝、显式 takeover 接管", async () => {
    const dir = tmpHome();
    // mkdir 后 owner 写入前崩溃的产物：有锁目录、无/坏 owner.json
    mkdirSync(join(dir, "room.lock"), { recursive: true });
    try {
      await acquireCas(join(dir, "room"), "sess-A");
      expect.unreachable("should throw");
    } catch (error) {
      expect((error as Error).message).toMatch(/orphan/);
    }
    expect(await acquireCas(join(dir, "room"), "sess-A", { takeoverOrphan: true })).toBe("acquired");

    const corrupt = join(dir, "corrupt.lock");
    mkdirSync(corrupt, { recursive: true });
    writeFileSync(join(corrupt, "owner.json"), "{not json");
    try {
      await acquireCas(join(dir, "corrupt"), "sess-A");
      expect.unreachable("should throw");
    } catch (error) {
      expect((error as Error).message).toMatch(/orphan/);
    }
  });

  it("withCasLock 异常路径也释放", async () => {
    const lock = join(tmpHome(), "room");
    await expect(withCasLock(lock, "s1", async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(await acquireCas(lock, "s2")).toBe("acquired");
  });
});

describe("任务账本", () => {
  function makeLedger(): { ledger: Ledger; home: string } {
    const home = tmpHome();
    return { ledger: new Ledger(home, join(layout(home).ledgerTasksDir)), home };
  }

  it("创建即 queued rev=1，update 合法迁移推进", async () => {
    const { ledger } = makeLedger();
    const task = await ledger.create({ title: "t1", room: "root", maxRounds: 3 });
    expect(task.status).toBe("queued");
    expect(task.rev).toBe(1);
    const updated = await ledger.update(task.id, { status: "running", assignee: "coder" });
    expect(updated.status).toBe("running");
    expect(updated.assignee).toBe("coder");
    expect(updated.rev).toBe(2);
  });

  it("非法迁移 / 不存在任务 / rounds 回退 全拒", async () => {
    const { ledger } = makeLedger();
    const task = await ledger.create({ title: "t" , room: "r" });
    await expect(ledger.update(task.id, { status: "done" })).rejects.toMatchObject({
      code: "illegal-transition",
    });
    await expect(ledger.update("task-nope", { status: "running" })).rejects.toMatchObject({
      code: "task-not-found",
    });
    await ledger.update(task.id, { rounds: 2 });
    await expect(ledger.update(task.id, { rounds: 1 })).rejects.toMatchObject({
      code: "rounds-regress",
    });
  });

  it("expectRev 乐观并发校验与 rounds 超限", async () => {
    const { ledger } = makeLedger();
    const task = await ledger.create({ title: "t", room: "r", maxRounds: 2 });
    await ledger.update(task.id, {}, { expectRev: 1 });
    await expect(ledger.update(task.id, {}, { expectRev: 1 })).rejects.toMatchObject({
      code: "rev-conflict",
    });
    await expect(
      ledger.update(task.id, { rounds: 3 }, { expectRev: task.rev + 1 }),
    ).rejects.toMatchObject({ code: "rounds-exceeded" });
  });

  it("list 返回全部任务并可识别损坏文件", async () => {
    const { ledger, home } = makeLedger();
    await ledger.create({ title: "a", room: "r" });
    await ledger.create({ title: "b", room: "r" });
    writeFileSync(join(home, "ledger", "tasks", "broken.json"), "{oops");
    const { tasks, corrupt } = await ledger.list();
    expect(tasks.map((t) => t.title).sort()).toEqual(["a", "b"]);
    expect(corrupt).toEqual(["broken.json"]);
  });

  it("findConflicts 分组互斥与 touched 交集", () => {
    const base = { title: "", room: "root", touched: [], mutexGroups: [] as string[], dod: [], createdAt: 0, updatedAt: 0, id: "x", rev: 1, rounds: 0, maxRounds: 0, status: "running" as const };
    const tasks = [
      { ...base, id: "a", mutexGroups: ["g1"] },
      { ...base, id: "b", mutexGroups: ["g1"] },
      { ...base, id: "c", touched: ["src/x.ts"], status: "queued" as const },
      { ...base, id: "d", touched: ["src/x.ts"] },
    ];
    const conflicts = findConflicts(tasks);
    expect(conflicts.map((c) => `${c.a}~${c.b}`)).toEqual(["a~b"]);
    expect(conflicts[0]?.reason).toMatch(/group/);
    // 不同房间不冲突
    const crossRoom = [
      { ...base, id: "p", room: "r1", touched: ["f"] },
      { ...base, id: "q", room: "r2", touched: ["f"] },
    ];
    expect(findConflicts(crossRoom)).toEqual([]);
  });
});

describe("事件流", () => {
  it("append 自增 seq，init 恢复游标", async () => {
    const file = join(tmpHome(), "events.jsonl");
    const log = new EventLog(file);
    await log.init();
    const first = await log.append({ session_id: "s1", actor: "system", type: "task/create" });
    const second = await log.append({ session_id: "s1", actor: "coder", type: "task/update", payload: { x: 1 } });
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    const log2 = new EventLog(file);
    await log2.init();
    const again = await log2.append({ session_id: "s1", actor: "qa", type: "handoff" });
    expect(again.seq).toBe(3);
  });

  it("read 回放 fromSeq 过滤", async () => {
    const file = join(tmpHome(), "events.jsonl");
    const log = new EventLog(file);
    await log.init();
    for (let i = 0; i < 3; i++) await log.append({ session_id: "s", actor: "a", type: `e${i}` });
    const { events } = await log.read(2);
    expect(events.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("截断尾行容错：tornTail 标记且不炸", async () => {
    const file = join(tmpHome(), "events.jsonl");
    const log = new EventLog(file);
    await log.init();
    await log.append({ session_id: "s", actor: "a", type: "ok" });
    const fsMod = await import("node:fs/promises");
    // 模拟 append 半途 kill：追加半行
    await fsMod.appendFile(file, '{"seq":2,"ts":');
    const log2 = new EventLog(file);
    await log2.init();
    expect(log2.hasTornTail()).toBe(true);
    const next = await log2.append({ session_id: "s", actor: "a", type: "after-crash" });
    expect(next.seq).toBe(2); // 坏行不计入游标
    const { events, corruptLines } = await log2.read();
    expect(events.filter((e) => e.type === "ok").length).toBe(1);
    expect(corruptLines.length).toBeGreaterThanOrEqual(1);
  });

  it("空文件 count=0", async () => {
    const file = join(tmpHome(), "events.jsonl");
    const log = new EventLog(file);
    await log.init();
    expect(await log.count()).toBe(0);
  });

  it("同路径多实例并发 append 10 次 → seq 单调不重复（Wave 1a 多写者护栏）", async () => {
    const file = join(tmpHome(), "events.jsonl");
    const logA = new EventLog(file);
    const logB = new EventLog(file);
    await logA.init();
    await logB.init();
    const seqs: number[] = [];
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 === 0 ? logA : logB).append({ session_id: "s", actor: "a", type: `e${i}` }),
      ),
    );
    for (const r of results) seqs.push(r.seq);
    // seq 全序唯一（严格递增排序后等于 1..10），无重复无缺口。
    expect([...seqs].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // 文件落盘行数一致，回放 seq 亦单调。
    const logC = new EventLog(file);
    await logC.init();
    const { events } = await logC.read();
    expect(events.map((e) => e.seq).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("append 失败不阻断后继 append，且失败不推进 seq 游标", async () => {
    const file = join(tmpHome(), "events.jsonl");
    const log = new EventLog(file);
    await log.init();
    const fsMod = await import("node:fs/promises");
    const spy = vi
      .spyOn(fsMod, "writeFile")
      .mockRejectedValueOnce(new Error("disk full"));
    try {
      // 首个 append 写文件失败 → reject；游标不推进。
      await expect(
        log.append({ session_id: "s", actor: "a", type: "boom" }),
      ).rejects.toThrow("disk full");
      // 后继 append 正常执行，链未被失败任务卡死；失败未推进游标 → seq=1。
      const first = await log.append({ session_id: "s", actor: "a", type: "ok" });
      expect(first.seq).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("注册表", () => {
  it("upsert/get/setStatus/liveMembers 对账语义", async () => {
    const reg = new Registry(tmpHome());
    expect((await reg.read()).members).toEqual({});
    await reg.upsertMember({
      member: "coder", durableId: "dur-1", parent: null, tier: 1,
      status: "spawned", lastSeen: Date.now(),
    });
    await reg.upsertMember({
      member: "master", durableId: "root", parent: null, tier: 0,
      status: "running", lastSeen: Date.now(),
    });
    expect((await reg.getMember("coder"))?.durableId).toBe("dur-1");
    await reg.setStatus("coder", "dead");
    const live = await reg.liveMembers();
    expect(live.map((m) => m.member)).toEqual(["master"]);
    await expect(reg.setStatus("ghost", "running")).rejects.toThrow(/not registered/);
  });

  it("upsert 三态判定（#79）：同 id 幂等刷新 / 异 id 拒绝 / dead 复活", async () => {
    const reg = new Registry(tmpHome());
    const coder = (durableId: string, status: MemberRecord["status"]) => ({
      member: "coder",
      durableId,
      parent: null,
      tier: 1,
      status,
      lastSeen: Date.now(),
    });
    // 首次登记
    expect(await reg.upsertMember(coder("dur-1", "spawned"))).toBe("registered");
    // 同 member + 同 durableId + 同 tier → 幂等成功：仅刷新 lastSeen，不改业务态。
    expect(await reg.upsertMember(coder("dur-1", "running"))).toBe("idempotent");
    const after = await reg.getMember("coder");
    expect(after?.durableId).toBe("dur-1");
    expect(after?.status).toBe("spawned");
    // 异 durableId 且旧记录非 dead → 拒绝（接管须先标 dead）。
    await expect(reg.upsertMember(coder("dur-2", "spawned"))).rejects.toMatchObject({
      code: "member-conflict",
    });
    // 标 dead 后允许复位重登记（状态级重建合法入口）。
    await reg.setStatus("coder", "dead");
    expect(await reg.upsertMember(coder("dur-2", "spawned"))).toBe("revived");
    expect((await reg.getMember("coder"))?.durableId).toBe("dur-2");
    // 异 tier 同样拒绝（身份锚点三元组整体比对）。
    await expect(reg.upsertMember({ ...coder("dur-2", "spawned"), tier: 2 })).rejects.toMatchObject({
      code: "member-conflict",
    });
  });
});

describe("gates", () => {
  it("open pending → resolve 单向；重复 open / 重开 resolved 即拒", async () => {
    const dir = join(tmpHome(), "gates");
    await ensureDir(dir);
    const gate = await openGate(dir, { id: "plan-approval", reason: "计划待批", requestedBy: "master" });
    expect(gate.status).toBe("pending");
    await expect(openGate(dir, { id: "plan-approval", reason: "x", requestedBy: "master" }))
      .rejects.toMatchObject({ code: "gate-exists" });
    const approved = await resolveGate(dir, "plan-approval", "approved", "human-web");
    expect(approved.status).toBe("approved");
    expect(approved.resolvedBy).toBe("human-web");
    await expect(resolveGate(dir, "plan-approval", "denied", "x"))
      .rejects.toMatchObject({ code: "gate-resolved" });
    await expect(resolveGate(dir, "nope", "approved", "x"))
      .rejects.toMatchObject({ code: "gate-not-found" });
    const listed = await listGates(dir);
    expect(listed.gates.map((g) => g.id)).toEqual(["plan-approval"]);
    expect((await readGate(dir, "plan-approval"))?.status).toBe("approved");
  });
});

describe("恢复原语", () => {
  it(".delivering TTL 收割：未超时不动、超时回待读、EEXIST 丢弃", async () => {
    const home = tmpHome();
    const mailbox = join(home, "mailbox", "coder");
    await ensureDir(mailbox);
    const fresh = join(mailbox, ".delivering-fresh.json");
    const stale = join(mailbox, ".delivering-stale.json");
    writeFileSync(fresh, JSON.stringify({ body: "new" }));
    writeFileSync(stale, JSON.stringify({ body: "old" }));
    const past = Date.now() - 60_000;
    const utimes = await import("node:fs/promises").then((m) => m.utimes);
    await utimes(stale, new Date(past), new Date(past));

    const result = await recoverDeliveries(join(home, "mailbox"), 30_000);
    expect(result).toEqual([{ member: "coder", uuid: "stale", action: "requeued" }]);
    expect(existsSync(join(mailbox, "stale.json"))).toBe(true);
    expect(existsSync(fresh)).toBe(true); // 未超时不动

    // 再来一个同 uuid 的残片（已过 TTL）：待读位已被占 → dropped
    writeFileSync(join(mailbox, ".delivering-stale.json"), "{}");
    await utimes(join(mailbox, ".delivering-stale.json"), new Date(past), new Date(past));
    const second = await recoverDeliveries(join(home, "mailbox"), 30_000);
    expect(second[0]?.action).toBe("dropped");
  });

  it("黑板 running 哨兵整分片作废", async () => {
    const home = tmpHome();
    const stateDir = join(roomLayout(home, "root").stateDir);
    await ensureDir(stateDir);
    writeFileSync(join(stateDir, "coder.json"), JSON.stringify({ status: "running", data: "dirty" }));
    writeFileSync(join(stateDir, "qa.json"), JSON.stringify({ status: "done", data: "clean" }));
    const result = await discardRunningSentinels(stateDir);
    expect(result).toEqual([{ role: "coder", action: "discarded" }]);
    expect((await readJson(join(stateDir, "qa.json")))?.status).toBe("done");
    expect(existsSync(join(stateDir, "coder.json"))).toBe(false);
  });
});

describe("layout 路径协议", () => {
  it("顶层与房间布局符合定稿 §3", () => {
    const l = layout("/team/home");
    expect(l.roomLock).toBe("/team/home/room"); // 资源基路径；锁目录为 room.lock
    expect(l.ledgerTasksDir).toBe("/team/home/ledger/tasks");
    expect(l.gatesDir).toBe("/team/home/gates");
    const r = roomLayout("/team/home", "root");
    expect(r.eventsFile).toBe("/team/home/rooms/root/events.jsonl");
    expect(r.stateDir).toBe("/team/home/rooms/root/state");
  });
});

describe("恢复原语边界补强", () => {
  it("非 .delivering 前缀 / 非 json 残片不收割", async () => {
    const home = tmpHome();
    const mailbox = join(home, "mailbox", "coder");
    await ensureDir(mailbox);
    writeFileSync(join(mailbox, ".delivering-stale.txt"), "{}"); // 后缀不符
    writeFileSync(join(mailbox, "stale.json"), "{}");            // 前缀不符
    const past = new Date(Date.now() - 60_000);
    const utimes = await import("node:fs/promises").then((m) => m.utimes);
    await utimes(join(mailbox, ".delivering-stale.txt"), past, past);
    expect(await recoverDeliveries(join(home, "mailbox"), 30_000)).toEqual([]);
  });

  it("stateDir 不存在时哨兵恢复返回空", async () => {
    expect(await discardRunningSentinels(join(tmpHome(), "no-such-state"))).toEqual([]);
  });

  it("状态机全组合枚举断言", async () => {
    const allowed = new Set([
      ["queued", "running"], ["queued", "cancelled"],
      ["running", "blocked"], ["running", "done"], ["running", "cancelled"],
      ["blocked", "running"], ["blocked", "cancelled"],
    ].map(([a, b]) => `${a}>${b}`));
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        expect(canTransition(from, to), `${from}->${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });
});

describe("账本字段级契约", () => {
  it("create 完整入参：读回值与落盘一致（含可选字段）", async () => {
    const home = tmpHome();
    const ledger = new Ledger(home, join(layout(home).ledgerTasksDir));
    const task = await ledger.create({
      title: "实现 X",
      room: "root",
      assignee: "coder",
      touched: ["src/a.ts"],
      mutexGroups: ["g-core"],
      maxRounds: 4,
      dod: ["lint 绿"],
      baseline: "abc123",
    });
    const readBack = await ledger.get(task.id);
    expect(readBack).toEqual({
      id: expect.stringMatching(/^task-[0-9a-f-]{36}$/),
      title: "实现 X",
      status: "queued",
      room: "root",
      assignee: "coder",
      touched: ["src/a.ts"],
      mutexGroups: ["g-core"],
      rounds: 0,
      maxRounds: 4,
      dod: ["lint 绿"],
      baseline: "abc123",
      rev: 1,
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    // 落盘文件名 = <id>.json
    expect(existsSync(join(layout(home).ledgerTasksDir, `${task.id}.json`))).toBe(true);
  });

  it("create 最小入参：默认值契约", async () => {
    const home = tmpHome();
    const ledger = new Ledger(home, join(layout(home).ledgerTasksDir));
    const task = await ledger.create({ title: "最小", room: "r" });
    expect(task.touched).toEqual([]);
    expect(task.mutexGroups).toEqual([]);
    expect(task.maxRounds).toBe(0);
    expect(task.dod).toEqual([]);
    expect(task.rounds).toBe(0);
    expect(task.rev).toBe(1);
    expect(task.assignee).toBeUndefined();
    expect(task.baseline).toBeUndefined();
    expect(task.artifact).toBeUndefined();
  });

  it("update 各补丁字段生效且 updatedAt 单调推进、artifact 可写入", async () => {
    const home = tmpHome();
    const ledger = new Ledger(home, join(layout(home).ledgerTasksDir));
    const task = await ledger.create({ title: "t", room: "r" });
    const u1 = await ledger.update(task.id, {
      title: "t2",
      status: "running",
      assignee: "qa",
      touched: ["f1"],
      mutexGroups: ["g"],
      rounds: 1,
      maxRounds: 9,
      dod: ["d1"],
      baseline: "b1",
      artifact: "archive/x.md",
    });
    expect(u1.title).toBe("t2");
    expect(u1.status).toBe("running");
    expect(u1.assignee).toBe("qa");
    expect(u1.touched).toEqual(["f1"]);
    expect(u1.mutexGroups).toEqual(["g"]);
    expect(u1.rounds).toBe(1);
    expect(u1.maxRounds).toBe(9);
    expect(u1.dod).toEqual(["d1"]);
    expect(u1.baseline).toBe("b1");
    expect(u1.artifact).toBe("archive/x.md");
    expect(u1.updatedAt).toBeGreaterThanOrEqual(u1.createdAt);
    expect(u1.rev).toBe(2);
  });
});
