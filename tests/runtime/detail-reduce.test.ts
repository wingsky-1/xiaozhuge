/**
 * 团队详情归约纯函数单测（issue #130；gui-plan 第五章 5.1 矩阵 T1-T11）。
 * 全部用例零 IO，工厂函数 + 显式注入 nowMs；stale 阈值断言一律以
 * STALE_THRESHOLD_MS 常量推导（防常量调参时用例漂移，R4/T10 口径）。
 */
import { describe, expect, it } from "vitest";
import type { MemberRecord, Shard, TaskRecord } from "../../src/runtime/index.js";
import {
  MAILBOX_PER_STATE_LIMIT,
  STALE_THRESHOLD_MS,
} from "../../src/runtime/index.js";
import type {
  DetailInput,
  MailboxHeadView,
  RoomShard,
  TeamDetailView,
} from "../../src/runtime/view/detail.js";
import {
  reduceDetail,
  staleAnnotations,
  taskCountsOf,
} from "../../src/runtime/view/detail.js";

/* ── 工厂区 ──────────────────────────────────────────────────────────── */

/** 原始账本记录工厂：允许字段缺省/脏值（模拟磁盘历史遗留形态），cast 进协议类型。 */
function rawTask(partial: Record<string, unknown>): TaskRecord {
  return {
    id: "task-x",
    title: "样例任务",
    status: "queued",
    room: "root",
    touched: [],
    mutexGroups: [],
    rounds: 0,
    maxRounds: 3,
    rev: 1,
    createdAt: 1000,
    updatedAt: 1000,
    ...partial,
  } as unknown as TaskRecord;
}

function head(id: string, over: Partial<MailboxHeadView> = {}): MailboxHeadView {
  return {
    id,
    to: "coder",
    from: "master",
    type: "task-assign",
    state: "unread",
    createdAt: 100,
    ...over,
  };
}

function member(name: string, over: Partial<MemberRecord> = {}): MemberRecord {
  return {
    member: name,
    durableId: `d-${name}`,
    parent: null,
    tier: 1,
    status: "running",
    lastSeen: 1_000_000,
    ...over,
  };
}

function shard(role: string, status: string, ext?: unknown): Shard {
  return { role, status, ...(ext !== undefined ? { ext } : {}), updatedAt: 5 };
}

function roomShard(room: string, s: Shard): RoomShard {
  return { room, shard: s };
}

function input(over: Partial<DetailInput> = {}): DetailInput {
  return {
    registry: { members: {} },
    tasks: [],
    corruptTaskFiles: [],
    mailboxes: [],
    shards: [],
    nowMs: 1_000_000,
    ...over,
  };
}

describe("T1 reduceDetail：空输入全形", () => {
  it("空账本/信箱/分片 → taskCounts 五键全 0、各区空数组，形状完全确定", () => {
    const detail = reduceDetail(input());
    expect(detail).toEqual({
      isTeam: false,
      tasks: [],
      corruptTaskFiles: [],
      taskCounts: { queued: 0, running: 0, blocked: 0, done: 0, cancelled: 0 },
      envelopes: [],
      shardBadges: [],
      masterIdle: false,
      staleMembers: [],
      awaitingInput: [],
    });
  });
});

describe("T2 保守投影：缺省字段 → null", () => {
  it("assignee/maxRounds/artifact 缺省（undefined）一律投影为 null", () => {
    const detail = reduceDetail(
      input({ tasks: [rawTask({ id: "task-1", assignee: undefined, maxRounds: undefined, artifact: undefined })] }),
    );
    expect(detail.tasks[0]).toMatchObject({
      id: "task-1",
      assignee: null,
      maxRounds: null,
      artifact: null,
    });
  });

  it("在场字段如实投影（含字段值 0 的 falsy 场景不被误判为缺省）", () => {
    const detail = reduceDetail(input({ tasks: [rawTask({ id: "task-1", assignee: "qa", maxRounds: 0, artifact: "" })] }));
    expect(detail.tasks[0]).toMatchObject({ assignee: "qa", maxRounds: 0, artifact: "" });
  });
});

describe("T3 任务排序确定性", () => {
  it("按 updatedAt desc；同值按 id asc 稳定 tiebreak", () => {
    const detail = reduceDetail(
      input({
        tasks: [
          rawTask({ id: "task-b", updatedAt: 200 }),
          rawTask({ id: "task-a", updatedAt: 200 }),
          rawTask({ id: "task-z", updatedAt: 300 }),
        ],
      }),
    );
    expect(detail.tasks.map((t) => t.id)).toEqual(["task-z", "task-a", "task-b"]);
  });
});

describe("T4 任务计数", () => {
  it("五状态各若干条计数精确；脏 status 不炸且不计入任何键（记录仍原样透传展示）", () => {
    const dirty = rawTask({ id: "task-dirty", status: "archived-legacy" });
    const detail = reduceDetail(
      input({
        tasks: [
          rawTask({ id: "t1", status: "queued" }),
          rawTask({ id: "t2", status: "running" }),
          rawTask({ id: "t3", status: "running" }),
          rawTask({ id: "t4", status: "blocked" }),
          rawTask({ id: "t5", status: "done" }),
          rawTask({ id: "t6", status: "cancelled" }),
          dirty,
        ],
      }),
    );
    expect(detail.taskCounts).toEqual({ queued: 1, running: 2, blocked: 1, done: 1, cancelled: 1 });
    // 脏记录本身仍入视图（GUI 显示原文），只是不参与计数。
    expect(detail.tasks.find((t) => t.id === "task-dirty")?.status).toBe("archived-legacy");
  });

  it("taskCountsOf 导出形态：空数组返回五键全 0（plugin 层短路体复用）", () => {
    expect(taskCountsOf([])).toEqual({ queued: 0, running: 0, blocked: 0, done: 0, cancelled: 0 });
  });
});

describe("T5 信封白名单投影（脱敏防线）", () => {
  it("入参意外携带 body/payload 等多余键也不出投影面：严格七键 toEqual + 序列化负向断言", () => {
    const smuggled = {
      id: "env-1",
      to: "coder",
      from: "master",
      type: "task-assign",
      state: "unread",
      createdAt: 100,
      body: { prompt: "SECRET-MARK" },
      payload: "PAYLOAD-MARK",
    } as unknown as MailboxHeadView;
    const detail = reduceDetail(input({ mailboxes: [smuggled] }));
    expect(detail.envelopes).toEqual([
      { id: "env-1", to: "coder", from: "master", type: "task-assign", state: "unread", createdAt: 100 },
    ]);
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("SECRET-MARK");
    expect(serialized).not.toContain("PAYLOAD-MARK");
    expect(serialized).not.toContain('"body"');
  });
});

describe("T6 信封三段状态流经归约保持不失真", () => {
  it("unread/claimed/acked 三态原样进入视图（文件位→state 的真实映射由 plugin 层扫描侧覆盖）", () => {
    const detail = reduceDetail(
      input({
        mailboxes: [
          head("e-u", { state: "unread", createdAt: 300 }),
          head("e-c", { state: "claimed", createdAt: 200 }),
          head("e-k", { state: "acked", createdAt: 100 }),
        ],
      }),
    );
    expect(detail.envelopes.map((e) => e.state)).toEqual(["unread", "claimed", "acked"]);
  });
});

describe("T7 信封排序与公平截断", () => {
  it("createdAt desc 全局排序；同值 id asc 稳定 tiebreak", () => {
    const detail = reduceDetail(
      input({
        mailboxes: [
          head("z", { createdAt: 10 }),
          head("b", { createdAt: 20 }),
          head("a", { createdAt: 20 }),
        ],
      }),
    );
    expect(detail.envelopes.map((e) => e.id)).toEqual(["a", "b", "z"]);
  });

  it(`每成员每 state 截至最新 ${MAILBOX_PER_STATE_LIMIT} 条`, () => {
    const mails = Array.from({ length: 8 }, (_, i) =>
      head(`e${i}`, { to: "coder", state: "unread", createdAt: 100 + i }),
    );
    const detail = reduceDetail(input({ mailboxes: mails }));
    expect(detail.envelopes.map((e) => e.id)).toEqual(["e7", "e6", "e5", "e4", "e3"]);
  });

  it("三段分别截断：同成员 unread/claimed/acked 各 6 条 → 每段各留 5、共 15", () => {
    const states = ["unread", "claimed", "acked"] as const;
    const mails = states.flatMap((state, si) =>
      Array.from({ length: 6 }, (_, i) =>
        head(`s${si}-e${i}`, { to: "coder", state, createdAt: 100 + i }),
      ),
    );
    const detail = reduceDetail(input({ mailboxes: mails }));
    expect(detail.envelopes.length).toBe(15);
    for (const state of states) {
      expect(detail.envelopes.filter((e) => e.state === state).length).toBe(MAILBOX_PER_STATE_LIMIT);
    }
  });

  it("多成员公平可见：两个发信方各 8 条 unread 互不淹没，各留 5 条", () => {
    const mails = [
      ...Array.from({ length: 8 }, (_, i) => head(`ha${i}`, { to: "member-a", createdAt: 100 + i })),
      ...Array.from({ length: 8 }, (_, i) => head(`hb${i}`, { to: "member-b", createdAt: 100 + i })),
    ];
    const detail = reduceDetail(input({ mailboxes: mails }));
    expect(detail.envelopes.filter((e) => e.to === "member-a").length).toBe(MAILBOX_PER_STATE_LIMIT);
    expect(detail.envelopes.filter((e) => e.to === "member-b").length).toBe(MAILBOX_PER_STATE_LIMIT);
  });
});

describe("T8 分片 ext 白名单", () => {
  it("current_activity 单键提取；其余 ext 键不泄漏（负向断言）", () => {
    const detail = reduceDetail(
      input({
        registry: { members: { coder: member("coder") } },
        shards: [
          roomShard(
            "root",
            shard("coder", "running", { current_activity: "重构核心模块", internal_note: "NOTE-MARK", secret: true }),
          ),
        ],
      }),
    );
    expect(detail.shardBadges[0]).toEqual({
      room: "root",
      role: "coder",
      status: "running",
      updatedAt: 5,
      currentActivity: "重构核心模块",
    });
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("NOTE-MARK");
    expect(serialized).not.toContain('"secret"');
    expect(serialized).not.toContain('"ext"');
  });

  it("ext 缺失 / current_activity 非字符串 / 空串 / ext 为原始值 → currentActivity 均为 null", () => {
    const detail = reduceDetail(
      input({
        shards: [
          roomShard("r1", shard("a", "running")),
          roomShard("r2", shard("b", "running", { current_activity: 42 })),
          roomShard("r3", shard("c", "running", { current_activity: "" })),
          roomShard("r4", shard("d", "running", "raw-ext")),
        ],
      }),
    );
    expect(detail.shardBadges.every((b) => b.currentActivity === null)).toBe(true);
  });
});

describe("T9 分片脏 status 容忍", () => {
  it("非保留态值原样进视图（GUI 显示原文），归约不抛", () => {
    const detail = reduceDetail(
      input({ shards: [roomShard("root", shard("coder", "weird-stage"))] }),
    );
    expect(detail.shardBadges[0]?.status).toBe("weird-stage");
  });
});

describe("T10 stale 判定矩阵（对齐 ADR 0016；镜像 handlers reconcile）", () => {
  const T = STALE_THRESHOLD_MS;
  const BASE = 1_000_000;

  it("a. running 超阈入 staleMembers；恰达阈值不算（严格大于 ±1ms 边界）", () => {
    const reg = { members: { coder: member("coder", { lastSeen: BASE }) } };
    const atThreshold = staleAnnotations(reg, [], BASE + T);
    expect(atThreshold.staleMembers).toEqual([]);
    expect(atThreshold.awaitingInput).toEqual([]);
    const beyond = staleAnnotations(reg, [], BASE + T + 1);
    expect(beyond.staleMembers).toEqual([{ member: "coder", lastSeenAgeMs: T + 1 }]);
  });

  it("b. spawned/stopped/dead 一律不入名册（dead 由 lost 着色表达防双计）", () => {
    const members = Object.fromEntries(
      (["spawned", "stopped", "dead"] as const).map((status, i) => [
        `m-${status}`,
        member(`m-${status}`, { status, lastSeen: BASE - T * 100 + i }),
      ]),
    );
    const out = staleAnnotations({ members }, [], BASE);
    expect(out.staleMembers).toEqual([]);
    expect(out.awaitingInput).toEqual([]);
  });

  it("c. tier0 超阈 → masterIdle=true 且不入 staleMembers；tier0 lastSeen 非有限 → masterIdle=false", () => {
    const withMaster = {
      members: {
        master: member("master", { tier: 0, durableId: "s-root", lastSeen: BASE }),
        coder: member("coder", { parent: "master", lastSeen: BASE }),
      },
    };
    const idle = staleAnnotations(withMaster, [], BASE + T + 1);
    expect(idle.masterIdle).toBe(true);
    expect(idle.staleMembers.some((a) => a.member === "master")).toBe(false);

    const nanMaster = {
      members: {
        master: member("master", { tier: 0, durableId: "s-root", lastSeen: Number.NaN }),
      },
    };
    expect(staleAnnotations(nanMaster, [], BASE + T * 10).masterIdle).toBe(false);

    // 无 tier0 成员 → masterIdle 恒 false。
    const noMaster = { members: { coder: member("coder", { lastSeen: BASE - T * 10 }) } };
    expect(staleAnnotations(noMaster, [], BASE).masterIdle).toBe(false);
  });

  it("d. 任一房间存在 blocked 分片 → 入 awaitingInput 免责档且不同时在 staleMembers", () => {
    const reg = { members: { qa: member("qa", { lastSeen: BASE }) } };
    const overdue = BASE + T + 1;
    // staleAnnotations 直接收 Shard[]（room 维度仅 shardBadges 需要）。
    const excused = staleAnnotations(reg, [shard("qa", "blocked")], overdue);
    expect(excused.awaitingInput).toEqual([{ member: "qa", lastSeenAgeMs: T + 1 }]);
    expect(excused.staleMembers).toEqual([]);
    // 非 blocked 分片不构成免责。
    const stillStale = staleAnnotations(reg, [roomShard("build", shard("qa", "running"))], overdue);
    expect(stillStale.staleMembers.some((a) => a.member === "qa")).toBe(true);
    expect(stillStale.awaitingInput).toEqual([]);
  });

  it("e. lastSeen 非有限（NaN/Infinity）→ 不参与判定不崩", () => {
    const reg = {
      members: {
        m1: member("m1", { lastSeen: Number.NaN }),
        m2: member("m2", { lastSeen: Number.POSITIVE_INFINITY }),
      },
    };
    const out = staleAnnotations(reg, [], BASE);
    expect(out.staleMembers).toEqual([]);
    expect(out.awaitingInput).toEqual([]);
  });

  it("f. 名册按 member localeCompare 升序输出", () => {
    const reg = {
      members: {
        "zz-mem": member("zz-mem", { lastSeen: BASE - T * 10 }),
        "aa-mem": member("aa-mem", { lastSeen: BASE - T * 20 }),
        "mm-mem": member("mm-mem", { lastSeen: BASE - T * 30 }),
      },
    };
    const out = staleAnnotations(reg, [], BASE);
    expect(out.staleMembers.map((a) => a.member)).toEqual(["aa-mem", "mm-mem", "zz-mem"]);
  });

  it("g. 时钟回拨（负 age）天然不超阈，不特判", () => {
    const reg = { members: { future: member("future", { lastSeen: BASE + T * 2 }) } };
    const out = staleAnnotations(reg, [], BASE);
    expect(out.staleMembers).toEqual([]);
    expect(out.awaitingInput).toEqual([]);
  });

  it("reduceDetail 整装联动：超阈候选按免责档分流进入视图模型", () => {
    const detail = reduceDetail(
      input({
        registry: {
          members: {
            master: member("master", { tier: 0, lastSeen: BASE }),
            coder: member("coder", { parent: "master", lastSeen: BASE - T * 10 }),
            qa: member("qa", { parent: "master", lastSeen: BASE - T * 20 }),
          },
        },
        shards: [roomShard("root", shard("qa", "blocked"))],
        nowMs: BASE,
      }),
    ) satisfies TeamDetailView;
    expect(detail.isTeam).toBe(true);
    expect(detail.masterIdle).toBe(false); // tier0 心跳新鲜
    expect(detail.staleMembers).toEqual([
      { member: "coder", lastSeenAgeMs: T * 10 },
    ]);
    expect(detail.awaitingInput).toEqual([
      { member: "qa", lastSeenAgeMs: T * 20 },
    ]);
  });
});

describe("T11 isTeam 语义", () => {
  it("空注册表（含各输入皆空）→ 全空态 + masterIdle=false，与路由短路体形状一致", () => {
    const detail = reduceDetail(input());
    expect(detail.isTeam).toBe(false);
    expect(detail.masterIdle).toBe(false);
    expect(detail.staleMembers).toEqual([]);
    expect(detail.awaitingInput).toEqual([]);
  });

  it("注册表为空但数据区有历史内容：isTeam=false，任务照实保留（归约不越权丢弃，短路在路由层）", () => {
    const detail = reduceDetail(input({ tasks: [rawTask({ id: "task-orphan", updatedAt: 500 })] }));
    expect(detail.isTeam).toBe(false);
    expect(detail.tasks.map((t) => t.id)).toEqual(["task-orphan"]);
  });
});
