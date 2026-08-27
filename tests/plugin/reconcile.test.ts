/**
 * team_reconcile 对账原语单测（ADR 0015 决策 1，#66）。
 * 覆盖：overview 全量视图（成员对照 / 悬空指派 / 状态分布 / 事件游标 /
 * goal 占位）、stale 心跳标注矩阵（master_idle / stale_members /
 * awaiting_input，#97 ADR 0016）、scope=audit 旁路 report-only（未登记
 * 文件 / 过期登记 / 敏感名掩码 / 无工作区不可用）、参数校验。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandlers, rootCaller, type Handlers } from "../../src/plugin/handlers.js";
import { Registry, STALE_THRESHOLD_MS } from "../../src/index.js";
import { DEFAULT_DELIVERING_TTL_MS } from "../../src/runtime/kernel/recovery.js";
import type { MemberRecord } from "../../src/runtime/kernel/types.js";

let home: string;
let handlers: Handlers;
let workspace: string;
const SESSION = "session-reconcile-1";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "xzg-rec-home-"));
  workspace = mkdtempSync(join(tmpdir(), "xzg-rec-ws-"));
  handlers = createHandlers(home, SESSION, rootCaller());
});

describe("team_reconcile overview", () => {
  it("一次调用返回快照摘要、成员对照、状态分布、事件游标与 goal 占位", async () => {
    await handlers.init({ project_root: workspace });
    await handlers.spawn({ member: "coder", durable_id: "dur-coder", role: "coder", tier: 1 });
    const t = (await handlers.taskCreate({
      title: "实现 X",
      room: "root",
      assignee: "coder",
      touched_paths: ["src/a.ts"],
    })) as { task_id: string };
    // 悬空指派：账本有 assignee、注册表无此成员。
    await handlers.taskUpdate({ task_id: t.task_id, assignee: "ghost" });

    const view = (await handlers.reconcile({})) as {
      ok: boolean;
      scope: string;
      initialized: boolean;
      snapshot: { source: string | null; workspace_seen?: unknown };
      members: Array<{ member: string; liveness: string; assigned_task_ids: string[] }>;
      dangling_assignees: string[];
      orphan_members: Array<{ member: string; tier: number; parent: string | null; reason: string }>;
      master_idle: boolean;
      stale_members: Array<{ member: string; last_seen_age_ms: number }>;
      awaiting_input: Array<{ member: string; last_seen_age_ms: number }>;
      task_status_counts: Record<string, number>;
      event_cursors: Array<{ room: string; seq: number }>;
      goal_binding: string;
      tool_manifest_pointer: string;
    };

    expect(view.ok).toBe(true);
    expect(view.scope).toBe("overview");
    expect(view.initialized).toBe(true);
    expect(view.snapshot?.source).toBe("builtin");
    expect(view.members).toHaveLength(2);
    // init 预登记的 tier0 主控（#79）：durableId = 宿主会话 id，对账可见。
    expect(view.members.find((m) => m.member === "master")).toMatchObject({
      durable_id: SESSION,
      liveness: "framework-invisible",
    });
    expect(view.members.find((m) => m.member === "coder")).toMatchObject({
      member: "coder",
      durable_id: "dur-coder",
      liveness: "framework-invisible",
    });
    expect(view.dangling_assignees).toEqual(["ghost"]);
    // 孤儿标红（report-only）：spawn 未传 parent → coder 标 parent-missing；
    // tier0 主控豁免（单入口原则）。
    expect(view.orphan_members).toEqual([
      { member: "coder", tier: 1, parent: null, reason: "parent-missing" },
    ]);
    // stale 心跳标注默认态（#97）：全员新鲜时零标注（golden 契约同步锚点）。
    expect(view.master_idle).toBe(false);
    expect(view.stale_members).toEqual([]);
    expect(view.awaiting_input).toEqual([]);
    expect(view.task_status_counts).toEqual({ queued: 1 });
    expect(view.event_cursors[0]?.room).toBe("root");
    expect(view.event_cursors[0]!.seq).toBeGreaterThan(0);
    expect(view.goal_binding).toContain("framework-invisible");
    expect(view.goal_binding).toContain("get_goal");
    expect(view.tool_manifest_pointer).toContain("tool manifest");
  });

  it("未初始化实例返回 initialized=false 且不抛错", async () => {
    const view = (await handlers.reconcile({})) as { initialized: boolean; snapshot: unknown };
    expect(view.initialized).toBe(false);
    expect(view.snapshot).toBeNull();
  });

  it("孤儿标红：有 parent 且在册不标；悬空 parent 标 parent-dangling", async () => {
    await handlers.init({ project_root: workspace });
    // coder 带合法 parent（master 由 init 预登记）→ 不标。
    await handlers.spawn({
      member: "coder",
      durable_id: "dur-coder",
      role: "coder",
      tier: 1,
      parent: "master",
    });
    // painter 的 parent 未注册 → 标 parent-dangling。
    await handlers.spawn({
      member: "painter",
      durable_id: "dur-painter",
      role: "painter",
      tier: 1,
      parent: "ghost-parent",
    });

    const view = (await handlers.reconcile({})) as {
      orphan_members: Array<{ member: string; tier: number; parent: string | null; reason: string }>;
    };
    expect(view.orphan_members).toEqual([
      { member: "painter", tier: 1, parent: "ghost-parent", reason: "parent-dangling" },
    ]);
  });

  it("互斥冲突标注恒在场（空数组形态）——T10 契约断言（#137）", async () => {
    await handlers.init({ project_root: workspace });
    const view = (await handlers.reconcile({})) as {
      active_mutex_conflicts: Array<{ a: string; b: string; reason: string }>;
    };
    expect(view.active_mutex_conflicts).toEqual([]);
  });

  it("T1 单任务 queued→running 无邻居 → 不标冲突", async () => {
    await handlers.init({ project_root: workspace });
    const t = (await handlers.taskCreate({
      title: "T1",
      room: "root",
      touched_paths: ["src/a.ts"],
      mutex_groups: ["g1"],
    })) as { task_id: string };
    await handlers.taskUpdate({ task_id: t.task_id, status: "running" });
    const view = (await handlers.reconcile({})) as {
      active_mutex_conflicts: Array<{ a: string; b: string; reason: string }>;
    };
    expect(view.active_mutex_conflicts).toEqual([]);
  });

  it("T3 同组先后 create 均 queued 共存 → 不标（尚非 running）", async () => {
    await handlers.init({ project_root: workspace });
    const t1 = (await handlers.taskCreate({
      title: "T3a", room: "root", mutex_groups: ["g1"],
    })) as { task_id: string };
    const t2 = (await handlers.taskCreate({
      title: "T3b", room: "root", mutex_groups: ["g1"],
    })) as { task_id: string };
    void t1;
    void t2;
    const view = (await handlers.reconcile({})) as {
      active_mutex_conflicts: Array<{ a: string; b: string; reason: string }>;
    };
    expect(view.active_mutex_conflicts).toEqual([]);
  });

  it("T4-RO B 转 running 撞 running 的 A（同组）→ 冲突对入标注", async () => {
    await handlers.init({ project_root: workspace });
    const a = (await handlers.taskCreate({
      title: "A", room: "root", mutex_groups: ["g1"],
    })) as { task_id: string };
    const b = (await handlers.taskCreate({
      title: "B", room: "root", mutex_groups: ["g1"],
    })) as { task_id: string };
    await handlers.taskUpdate({ task_id: a.task_id, status: "running" });
    await handlers.taskUpdate({ task_id: b.task_id, status: "running" });
    const view = (await handlers.reconcile({})) as {
      active_mutex_conflicts: Array<{ a: string; b: string; reason: string }>;
    };
    expect(view.active_mutex_conflicts).toHaveLength(1);
    expect(view.active_mutex_conflicts[0]!.reason).toContain("shared mutex group: g1");
    // 冲突对双方为 A/B（次序无关）。
    const pair = [view.active_mutex_conflicts[0]!.a, view.active_mutex_conflicts[0]!.b].sort();
    expect(pair).toEqual([a.task_id, b.task_id].sort());
  });

  it("T5-RO touched 字面交集撞车 → 冲突对入标注", async () => {
    await handlers.init({ project_root: workspace });
    const a = (await handlers.taskCreate({
      title: "A", room: "root", touched_paths: ["src/x.ts"],
    })) as { task_id: string };
    const b = (await handlers.taskCreate({
      title: "B", room: "root", touched_paths: ["src/x.ts"],
    })) as { task_id: string };
    await handlers.taskUpdate({ task_id: a.task_id, status: "running" });
    await handlers.taskUpdate({ task_id: b.task_id, status: "running" });
    const view = (await handlers.reconcile({})) as {
      active_mutex_conflicts: Array<{ a: string; b: string; reason: string }>;
    };
    expect(view.active_mutex_conflicts).toHaveLength(1);
    expect(view.active_mutex_conflicts[0]!.reason).toContain("touched path overlap: src/x.ts");
  });

  it("T5-盲 A 双字段并存：判定次序先 mutexGroups 后 touched，reason 固定为 mutex（#137）", async () => {
    await handlers.init({ project_root: workspace });
    const a = (await handlers.taskCreate({
      title: "A", room: "root",
      touched_paths: ["src/x.ts"], mutex_groups: ["g1"],
    })) as { task_id: string };
    const b = (await handlers.taskCreate({
      title: "B", room: "root",
      touched_paths: ["src/x.ts"], mutex_groups: ["g1"],
    })) as { task_id: string };
    await handlers.taskUpdate({ task_id: a.task_id, status: "running" });
    await handlers.taskUpdate({ task_id: b.task_id, status: "running" });
    const view = (await handlers.reconcile({})) as {
      active_mutex_conflicts: Array<{ a: string; b: string; reason: string }>;
    };
    expect(view.active_mutex_conflicts).toHaveLength(1);
    expect(view.active_mutex_conflicts[0]!.reason).toContain("shared mutex group: g1");
  });

  it("T7 异 room 共享组 → 不冲突（room 隔离）", async () => {
    await handlers.init({ project_root: workspace });
    const a = (await handlers.taskCreate({
      title: "A", room: "root", mutex_groups: ["g1"],
    })) as { task_id: string };
    const b = (await handlers.taskCreate({
      title: "B", room: "work", mutex_groups: ["g1"],
    })) as { task_id: string };
    await handlers.taskUpdate({ task_id: a.task_id, status: "running" });
    await handlers.taskUpdate({ task_id: b.task_id, status: "running" });
    const view = (await handlers.reconcile({})) as {
      active_mutex_conflicts: Array<{ a: string; b: string; reason: string }>;
    };
    expect(view.active_mutex_conflicts).toEqual([]);
  });

  it("T8 done/cancelled/blocked 作参照方 → 不入比较集", async () => {
    await handlers.init({ project_root: workspace });
    const running = (await handlers.taskCreate({
      title: "running", room: "root", mutex_groups: ["g1"],
    })) as { task_id: string };
    const done = (await handlers.taskCreate({
      title: "done", room: "root", mutex_groups: ["g1"],
    })) as { task_id: string };
    const blocked = (await handlers.taskCreate({
      title: "blocked", room: "root", mutex_groups: ["g1"],
    })) as { task_id: string };
    await handlers.taskUpdate({ task_id: running.task_id, status: "running" });
    // done 也只能由 running 迁入（queued→done 非法，types.ts:40-46）。
    await handlers.taskUpdate({ task_id: done.task_id, status: "running" });
    await handlers.taskUpdate({ task_id: done.task_id, status: "done" });
    // blocked 同理。
    await handlers.taskUpdate({ task_id: blocked.task_id, status: "running" });
    await handlers.taskUpdate({ task_id: blocked.task_id, status: "blocked" });
    const view = (await handlers.reconcile({})) as {
      active_mutex_conflicts: Array<{ a: string; b: string; reason: string }>;
    };
    expect(view.active_mutex_conflicts).toEqual([]);
  });
});

describe("team_reconcile stale 心跳标注（#97 ADR 0016）", () => {
  const NOW = 1_700_000_000_000;
  const STALE_TS = NOW - STALE_THRESHOLD_MS - 60_000; // 超阈一分钟

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 直接改写 agents.json 中某成员记录（绕过工具面构造任意 lastSeen/status）。 */
  async function seedMember(name: string, patch: Partial<MemberRecord>): Promise<void> {
    const reg = new Registry(home);
    const data = await reg.read();
    if (data.members[name] === undefined) throw new Error(`member ${name} not seeded`);
    Object.assign(data.members[name]!, patch);
    await reg.write(data);
  }

  async function reconcile(): Promise<{
    master_idle: boolean;
    stale_members: Array<{ member: string; last_seen_age_ms: number }>;
    awaiting_input: Array<{ member: string; last_seen_age_ms: number }>;
  }> {
    return (await handlers.reconcile({})) as never;
  }

  it("全员新鲜 → master_idle=false 且两档名册皆空", async () => {
    await handlers.init({});
    await handlers.spawn({ member: "coder", durable_id: "dur-coder", role: "coder", tier: 1 });
    await seedMember("coder", { status: "running" });
    const view = await reconcile();
    expect(view.master_idle).toBe(false);
    expect(view.stale_members).toEqual([]);
    expect(view.awaiting_input).toEqual([]);
  });

  it("running 成员超阈入 stale_members 并携带静默时长；主控不入名册", async () => {
    await handlers.init({});
    await handlers.spawn({ member: "coder", durable_id: "dur-coder", role: "coder", tier: 1 });
    await seedMember("coder", { status: "running", lastSeen: STALE_TS });
    const view = await reconcile();
    expect(view.stale_members).toEqual([{ member: "coder", last_seen_age_ms: NOW - STALE_TS }]);
    expect(view.stale_members.map((m) => m.member)).not.toContain("master");
    expect(view.master_idle).toBe(false);
  });

  it("tier0 主控超阈仅亮 master_idle（消除自刷矛盾与续命放大通道）", async () => {
    await handlers.init({});
    await handlers.spawn({ member: "coder", durable_id: "dur-coder", role: "coder", tier: 1 });
    await seedMember("master", { lastSeen: STALE_TS });
    const view = await reconcile();
    expect(view.master_idle).toBe(true);
    expect(view.stale_members).toEqual([]);
  });

  it("dead / spawned / stopped 一律不收录（lost 与非干活中豁免）", async () => {
    await handlers.init({});
    for (const m of ["dead-one", "spawned-one", "stopped-one"]) {
      await handlers.spawn({ member: m, durable_id: `dur-${m}`, role: m, tier: 1 });
    }
    await seedMember("dead-one", { status: "dead", lastSeen: STALE_TS });
    await seedMember("spawned-one", { status: "spawned", lastSeen: STALE_TS });
    await seedMember("stopped-one", { status: "stopped", lastSeen: STALE_TS });
    const view = await reconcile();
    expect(view.stale_members).toEqual([]);
    expect(view.awaiting_input).toEqual([]);
  });

  it("超阈且黑板任一分片 blocked 归 awaiting_input 免责档，不再双列", async () => {
    await handlers.init({});
    await handlers.spawn({ member: "waiter", durable_id: "dur-waiter", role: "waiter", tier: 1 });
    // 先置 blocked 分片再回拨时钟：state_set 会刷 waiter lastSeen 到当前。
    await handlers.stateSet({ room: "root", role: "waiter", status: "blocked" });
    await seedMember("waiter", { status: "running", lastSeen: STALE_TS });
    const view = await reconcile();
    expect(view.awaiting_input).toEqual([{ member: "waiter", last_seen_age_ms: NOW - STALE_TS }]);
    expect(view.stale_members).toEqual([]);
  });

  it("自属分片跨房间聚合：第二房间 blocked 同样免责；无分片对照者照常入 stale_members", async () => {
    await handlers.init({});
    await handlers.spawn({ member: "w1", durable_id: "dur-w1", role: "w1", tier: 1 });
    await handlers.spawn({
      member: "bystander", durable_id: "dur-bystander", role: "bystander", tier: 1,
    });
    // w1 的自属 blocked 分片写入第二房间（非 root）：豁免语义＝其分片在
    // 任一房间 blocked 即免责（blockedIndex 按角色跨房间聚合）；room 仅
    // 命名空间非权限边界（#123 口径），stateSet 可直接构造新房间。
    // state_set 会刷 lastSeen 到当前，先写分片再回拨时钟。
    await handlers.stateSet({ room: "work", role: "w1", status: "blocked" });
    await seedMember("w1", { status: "running", lastSeen: STALE_TS });
    await seedMember("bystander", { status: "running", lastSeen: STALE_TS });
    const view = await reconcile();
    expect(view.awaiting_input).toEqual([{ member: "w1", last_seen_age_ms: NOW - STALE_TS }]);
    expect(view.stale_members).toEqual([
      { member: "bystander", last_seen_age_ms: NOW - STALE_TS },
    ]);
  });

  it("恰达阈值不标（严格大于，宁少标勿错标）；未来时间戳（挂钟回拨）同样不标", async () => {
    await handlers.init({});
    await handlers.spawn({ member: "edge", durable_id: "dur-edge", role: "edge", tier: 1 });
    await handlers.spawn({ member: "future", durable_id: "dur-future", role: "future", tier: 1 });
    await seedMember("edge", { status: "running", lastSeen: NOW - STALE_THRESHOLD_MS }); // age 恰等于阈值
    await seedMember("future", { status: "running", lastSeen: NOW + 600_000 });
    const view = await reconcile();
    expect(view.stale_members).toEqual([]);
  });

  it("STALE_THRESHOLD_MS 锚点恒等：3× delivering TTL（协议常量区与 recovery 层不漂移脱钩）", () => {
    // types.ts 受 kernel 零反向依赖约束不能 import recovery.ts，
    // 锚点关系只能在测试层锁定（审核建议 1）。
    expect(STALE_THRESHOLD_MS).toBe(3 * DEFAULT_DELIVERING_TTL_MS);
  });

  it("多名册按 member 字典序稳定输出（不随注册顺序漂移）", async () => {
    await handlers.init({});
    // 故意以逆字典序登记。
    for (const m of ["zeta", "mid", "alpha"]) {
      await handlers.spawn({ member: m, durable_id: `dur-${m}`, role: m, tier: 1 });
      await seedMember(m, { status: "running", lastSeen: STALE_TS });
    }
    const view = await reconcile();
    expect(view.stale_members.map((m) => m.member)).toEqual(["alpha", "mid", "zeta"]);
    // age 一致（同 lastSeen），形态完整。
    expect(view.stale_members.every((m) => m.last_seen_age_ms === NOW - STALE_TS)).toBe(true);
  });
});

describe("team_reconcile scope=audit", () => {
  it("双向 diff：未登记文件命中、登记在案不误报、过期登记入 stale", async () => {
    // 工作树：src/a.ts（将登记）+ build.log（不登记）。
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "a.ts"), "export {};\n");
    writeFileSync(join(workspace, "build.log"), "noise\n");

    await handlers.init({ project_root: workspace });
    await handlers.taskCreate({
      title: "T",
      room: "root",
      touched_paths: ["src/a.ts", "gone/missing.ts"],
    });

    const view = (await handlers.reconcile({ scope: "audit" })) as {
      audit: {
        available: boolean;
        scanned_root: string;
        unregistered_files: Array<{ path: string; size: number; sensitive_masked: boolean }>;
        stale_registered_paths: string[];
        truncated: boolean;
      };
    };

    expect(view.audit.available).toBe(true);
    expect(view.audit.scanned_root).toBe(workspace);
    const paths = view.audit.unregistered_files.map((f) => f.path);
    expect(paths).toContain("build.log");
    expect(paths).not.toContain(join("src", "a.ts"));
    expect(view.audit.stale_registered_paths).toEqual(["gone/missing.ts"]);
    expect(view.audit.truncated).toBe(false);
    // 元数据形态：size/mtime 为数值，绝无内容字段。
    const f = view.audit.unregistered_files.find((x) => x.path === "build.log")!;
    expect(typeof f.size).toBe("number");
    expect(f.sensitive_masked).toBe(false);
    expect(Object.keys(f)).not.toContain("content");
  });

  it("敏感文件名打掩码，完整名不外泄", async () => {
    writeFileSync(join(workspace, ".env.local"), "SECRET=1\n");
    await handlers.init({ project_root: workspace });
    const view = (await handlers.reconcile({ scope: "audit" })) as {
      audit: { unregistered_files: Array<{ path: string; sensitive_masked: boolean }> };
    };
    const masked = view.audit.unregistered_files.find((f) => f.sensitive_masked);
    expect(masked).toBeDefined();
    expect(masked!.path).not.toContain(".env.local");
    expect(masked!.path.endsWith("<masked:sensitive-name>")).toBe(true);
  });

  it("旧快照无 workspace 字段 → 审计诚实标注不可用", async () => {
    await handlers.init({});
    const view = (await handlers.reconcile({ scope: "audit" })) as {
      audit: { available: boolean; reason: string };
    };
    expect(view.audit.available).toBe(false);
    expect(view.audit.reason).toContain("audit unavailable");
  });
});

describe("team_reconcile 参数校验", () => {
  it("非法 scope 拒绝", async () => {
    await handlers.init({});
    await expect(handlers.reconcile({ scope: "everything" })).rejects.toMatchObject({
      code: "invalid-arguments",
    });
  });
});
