/**
 * 团队视图归约纯函数单测（issue #68 验收第 4 条：归约与渲染分离，
 * 视图正确性 = 归约正确性）。全部用例零 IO，直接驱动纯函数断言。
 */
import { describe, expect, it } from "vitest";
import type { EventRecord, Shard } from "../../src/runtime/index.js";
import {
  currentActivityOf,
  reduceOverview,
  reduceRoom,
  toneOfShard,
} from "../../src/runtime/view/overview.js";

function shard(role: string, status: string, ext?: unknown): Shard {
  return { role, status, ...(ext !== undefined ? { ext } : {}), updatedAt: 1 };
}

function event(seq: number, actor: string, type: string): EventRecord {
  return { seq, ts: 1000 + seq, session_id: "s0", actor, type, payload: { secret: true } };
}

describe("toneOfShard：分片保留态 → 活动着色", () => {
  it("blocked/running/done 一一映射，无分片与其余值一律 idle", () => {
    expect(toneOfShard(shard("a", "blocked"))).toBe("blocked");
    expect(toneOfShard(shard("a", "running"))).toBe("running");
    expect(toneOfShard(shard("a", "done"))).toBe("done");
    expect(toneOfShard(undefined)).toBe("idle");
    // 非保留态脏值（历史残留/外部写入）不炸归约，落静默灰态。
    expect(toneOfShard(shard("a", "weird"))).toBe("idle");
  });
});

describe("currentActivityOf：ext 优先，事件尾部次之", () => {
  it("ext.current_activity 非空字符串时优先于事件", () => {
    const events = [event(1, "coder", "task/create")];
    expect(currentActivityOf("coder", shard("coder", "running", { current_activity: "改代码" }), events)).toBe(
      "改代码",
    );
  });

  it("ext 缺失或非字符串时回退该成员最近一条事件的 type", () => {
    const events = [event(1, "coder", "task/create"), event(2, "coder", "task/update"), event(3, "qa", "mailbox/ack")];
    expect(currentActivityOf("coder", shard("coder", "running"), events)).toBe("task/update");
    expect(currentActivityOf("coder", shard("coder", "running", { current_activity: "" }), events)).toBe(
      "task/update",
    );
    expect(currentActivityOf("coder", shard("coder", "running", { current_activity: 42 }), events)).toBe(
      "task/update",
    );
  });

  it("两者皆无返回 null；空事件流不炸", () => {
    expect(currentActivityOf("ghost", undefined, [])).toBeNull();
  });
});

describe("reduceRoom：计数与事件摘要投影", () => {
  it("按分片着色计数；payload 不出投影面", () => {
    const view = reduceRoom({
      room: "root",
      events: [event(1, "system", "team/init"), event(2, "coder", "blackboard/set")],
      shards: [shard("coder", "running"), shard("qa", "blocked"), shard("judge", "done")],
    });
    expect(view.room).toBe("root");
    expect(view.counts).toEqual({ running: 1, blocked: 1, done: 1, idle: 0, lost: 0 });
    expect(view.recentEvents).toEqual([
      { seq: 1, ts: 1001, actor: "system", type: "team/init" },
      { seq: 2, ts: 1002, actor: "coder", type: "blackboard/set" },
    ]);
    // 最小暴露：序列化结果不含任何 payload 字段。
    expect(JSON.stringify(view)).not.toContain("secret");
  });

  it("空房间返回空态", () => {
    const view = reduceRoom({ room: "r2", events: [], shards: [] });
    expect(view.counts).toEqual({ running: 0, blocked: 0, done: 0, idle: 0, lost: 0 });
    expect(view.recentEvents).toEqual([]);
  });
});

describe("reduceOverview：成员表与 isTeam 判定", () => {
  it("注册成员逐个投影；孤儿 parent 保留原值由前端挂 root；多房间同角色取字典序首个房间的分片", () => {
    const overview = reduceOverview({
      registry: {
        members: {
          coder: { member: "coder", durableId: "d-coder", tier: 1, parent: "master", status: "running", lastSeen: 7 },
          master: { member: "master", durableId: "d-master", parent: null, tier: 0, status: "running", lastSeen: 9 },
        },
      },
      rooms: [
        {
          room: "alpha",
          events: [event(1, "coder", "blackboard/set")],
          shards: [shard("coder", "blocked")],
        },
        {
          room: "root",
          events: [],
          shards: [shard("coder", "running")],
        },
      ],
    });
    expect(overview.isTeam).toBe(true);
    const byName = Object.fromEntries(overview.members.map((m) => [m.member, m]));
    // alpha 字典序在 root 前 → coder 取 alpha 的 blocked 分片。
    expect(byName["coder"]).toMatchObject({
      tier: 1,
      parent: "master",
      durableId: "d-coder",
      registryStatus: "running",
      tone: "blocked",
      currentActivity: "blackboard/set",
      lastSeen: 7,
    });
    // Q3（#164）：master 无分片但 registry=running → running 可见（不再静默）。
    expect(byName["master"]?.tone).toBe("running");
  });

  it("Q3 等价性：无分片 registry=running 成员可见 running；spawned/stopped 落 idle；blocked 仅分片权威", () => {
    // 无分片 + registry=running → running（核心痛点：谁写分片谁显示进度已废除）。
    const runningNoShard = reduceOverview({
      registry: {
        members: {
          coder: { member: "coder", durableId: "d-coder", tier: 1, parent: "master", status: "running", lastSeen: 7 },
        },
      },
      rooms: [{ room: "root", events: [], shards: [] }],
    });
    expect(runningNoShard.members[0]).toMatchObject({ tone: "running", registryStatus: "running" });
    // spawned/stopped 无分片 → idle（明确静默，非排队）。
    const spawnedNoShard = reduceOverview({
      registry: {
        members: {
          fresh: { member: "fresh", durableId: "d-f", tier: 1, parent: "master", status: "spawned", lastSeen: 2 },
          paused: { member: "paused", durableId: "d-p", tier: 1, parent: "master", status: "stopped", lastSeen: 3 },
        },
      },
      rooms: [],
    });
    expect(spawnedNoShard.members.map((m) => [m.member, m.tone])).toEqual([
      ["fresh", "idle"],
      ["paused", "idle"],
    ]);
    // 反例 I：registry=blocked 但无分片 → 保守 idle（blocked 唯一权威 = 黑板分片，
    // 避免「展示 blocked 而免责索引不认」的漂移）。
    const blockedNoShard = reduceOverview({
      registry: {
        members: {
          stuck: { member: "stuck", durableId: "d-s", tier: 1, parent: "master", status: "blocked", lastSeen: 8 },
        },
      },
      rooms: [],
    });
    expect(blockedNoShard.members[0]).toMatchObject({ tone: "idle", registryStatus: "blocked" });
    // 分片权威覆盖 registry：registry=dead 一票否决 lost（保持既有语义）。
    const deadWithRunningShard = reduceOverview({
      registry: {
        members: {
          ghost: { member: "ghost", durableId: "d-g", tier: 1, parent: "master", status: "dead", lastSeen: 3 },
        },
      },
      rooms: [{ room: "root", events: [], shards: [shard("ghost", "running")] }],
    });
    expect(deadWithRunningShard.members[0]).toMatchObject({ tone: "lost", registryStatus: "dead" });
    // 分片保留态权威高于 registry（分片 blocked 优先于 registry=running）。
    const shardOverRegistry = reduceOverview({
      registry: {
        members: {
          coder: { member: "coder", durableId: "d-coder", tier: 1, parent: "master", status: "running", lastSeen: 7 },
        },
      },
      rooms: [{ room: "root", events: [], shards: [shard("coder", "blocked")] }],
    });
    expect(shardOverRegistry.members[0]).toMatchObject({ tone: "blocked", registryStatus: "running" });
    // 旧数据回落：无分片 + 无事件 + registry=spawned → idle 不炸（空 rooms 兼容）。
    const legacy = reduceOverview({
      registry: {
        members: {
          old: { member: "old", durableId: "d-o", tier: 1, parent: "master", status: "spawned", lastSeen: 0 },
        },
      },
      rooms: [],
    });
    expect(legacy.members[0]).toMatchObject({ tone: "idle", registryStatus: "spawned" });
    expect(legacy.rooms).toEqual([]);
  });

  it("dead 成员一票否决为 lost（liveness 优先于黑板遗留活动态）", () => {
    const overview = reduceOverview({
      registry: {
        members: {
          ghost: { member: "ghost", durableId: "d-g", tier: 1, status: "dead", lastSeen: 3 },
        },
      },
      rooms: [{ room: "root", events: [], shards: [shard("ghost", "running")] }],
    });
    expect(overview.members[0]).toMatchObject({ tone: "lost", registryStatus: "dead" });
    // stopped 是明确的静默而非排队：无分片 → idle。
    const stopped = reduceOverview({
      registry: {
        members: {
          paused: { member: "paused", durableId: "d-p", tier: 1, status: "stopped", lastSeen: 4 },
        },
      },
      rooms: [],
    });
    expect(stopped.members[0]?.tone).toBe("idle");
  });

  it("未写过黑板的成员仍可见（灰态），保证 L1 一屏可见全团队；lastSeen 非有限数兜底 null", () => {
    const overview = reduceOverview({
      registry: {
        members: {
          idle: { member: "idle", durableId: "d-idle", tier: 1, status: "spawned", lastSeen: Number.NaN },
        },
      },
      rooms: [],
    });
    expect(overview.members[0]).toMatchObject({
      member: "idle",
      tone: "idle",
      currentActivity: null,
      lastSeen: null,
    });
    expect(overview.rooms).toEqual([]);
  });

  it("members 为空即非团队实例", () => {
    const overview = reduceOverview({ registry: { members: {} }, rooms: [{ room: "root", events: [], shards: [] }] });
    expect(overview.isTeam).toBe(false);
    expect(overview.members).toEqual([]);
    expect(overview.masterRegistered).toBe(false);
  });

  it("masterRegistered：tier0 在册为 true；仅执行成员（旧实例）为 false（#79）", () => {
    const withMaster = reduceOverview({
      registry: {
        members: {
          master: { member: "master", durableId: "session-root", parent: null, tier: 0, status: "running", lastSeen: 1 },
          coder: { member: "coder", durableId: "d-coder", parent: "master", tier: 1, status: "spawned", lastSeen: 2 },
        },
      },
      rooms: [],
    });
    expect(withMaster.masterRegistered).toBe(true);
    const withoutMaster = reduceOverview({
      registry: {
        members: {
          coder: { member: "coder", durableId: "d-coder", parent: null, tier: 1, status: "spawned", lastSeen: 2 },
        },
      },
      rooms: [],
    });
    // 信号单向：只识别「未登记」，不判定「登记了但未跑对账」。
    expect(withoutMaster.isTeam).toBe(true);
    expect(withoutMaster.masterRegistered).toBe(false);
  });
});
