/**
 * 协议偏差机械检测单测（#212 P0-2，ADR 0024）。
 *
 * golden 矩阵（评审维度 8）：
 * - 正向检出 ×3：no-delegation / rooms 污染派生标注（audit）/ blackboard-silent；
 * - 反向不误报 ×2：绝对路径补写（master-rewritten）不告警；业务 rooms/（无
 *   root 运行时特征）不标污染；
 * - 宽限窗与首检去重：grace 内 available；warning 首检落留痕，repeat 不重复 append。
 * 检测器（kernel/protocol-health.ts）为纯函数，输入由事件统计 + 显式 flag 提供。
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectEventStats,
  evaluateProtocolHealth,
  emptyEventStats,
  briefHasFrameworkMarker,
  BRIEF_FRAMEWORK_MARKER,
  NO_DELEGATION_GRACE_MS,
  DEVIATION_EVENT,
} from "../../src/runtime/index.js";
import { EventLog } from "../../src/runtime/kernel/event-log.js";

async function seedEvents(
  roomsDir: string,
  room: string,
  events: Array<{ actor: string; type: string; payload: unknown }>,
): Promise<void> {
  const dir = join(roomsDir, room);
  mkdirSync(dir, { recursive: true });
  const log = new EventLog(join(dir, "events.jsonl"));
  await log.init();
  for (const ev of events) {
    await log.append({ session_id: "s-test", actor: ev.actor, type: ev.type, payload: ev.payload });
  }
}

const BASE_INPUT = {
  initialized: true,
  briefFrameworkWritten: true as boolean | null,
  briefExists: true,
  briefHasFrameworkMarker: true,
  blackboardRequiredRoles: [] as string[],
  stats: emptyEventStats(),
  nowMs: 0,
};

describe("brief 三态检测", () => {
  it("framework-written 在场 = available", () => {
    const r = evaluateProtocolHealth({ ...BASE_INPUT });
    const brief = r.items.find((i) => i.check === "brief")!;
    expect(brief.status).toBe("available");
    expect(brief.detail).toContain("framework-written");
  });

  it("缺失 = warning 且文案强制绝对路径（防相对路径再次污染 cwd）", () => {
    const r = evaluateProtocolHealth({ ...BASE_INPUT, briefExists: false });
    const brief = r.items.find((i) => i.check === "brief")!;
    expect(brief.status).toBe("warning");
    expect(brief.detail).toContain("ABSOLUTE");
    expect(brief.detail).toContain("NEVER a relative path");
  });

  it("存量实例（快照无标志）= not-applicable（防升级全量误报）", () => {
    const r = evaluateProtocolHealth({
      ...BASE_INPUT,
      briefFrameworkWritten: null,
      briefExists: false,
    });
    const brief = r.items.find((i) => i.check === "brief")!;
    expect(brief.status).toBe("not-applicable");
  });

  it("master 补写（无水印在场）= available 并标注接管形态", () => {
    const r = evaluateProtocolHealth({ ...BASE_INPUT, briefHasFrameworkMarker: false });
    const brief = r.items.find((i) => i.check === "brief")!;
    expect(brief.status).toBe("available");
    expect(brief.detail).toContain("master-rewritten");
  });
});

describe("no-delegation / 半委派检测", () => {
  it("宽限窗内零委派 = available（防刚建团即误报）", () => {
    const stats = { ...emptyEventStats(), initTs: 1_000 };
    const r = evaluateProtocolHealth({ ...BASE_INPUT, stats, nowMs: 1_000 + 60_000 });
    const d = r.items.find((i) => i.check === "delegation")!;
    expect(d.status).toBe("available");
    expect(d.detail).toContain("grace");
  });

  it("宽限窗外零信号 = warning（no-delegation）", () => {
    const stats = { ...emptyEventStats(), initTs: 0 };
    const r = evaluateProtocolHealth({
      ...BASE_INPUT,
      stats,
      nowMs: NO_DELEGATION_GRACE_MS + 1,
    });
    const d = r.items.find((i) => i.check === "delegation")!;
    expect(d.status).toBe("warning");
    expect(d.detail).toContain("no delegation");
  });

  it("半委派形态（有投递、无注册无账本）= 独立告警文案", () => {
    const stats = { ...emptyEventStats(), initTs: 0, deliver: 3 };
    const r = evaluateProtocolHealth({
      ...BASE_INPUT,
      stats,
      nowMs: NO_DELEGATION_GRACE_MS + 1,
    });
    const d = r.items.find((i) => i.check === "delegation")!;
    expect(d.status).toBe("warning");
    expect(d.detail).toContain("unregistered dispatch");
  });

  it("反向：spawn/task_create 在场 = available 不告警", () => {
    const stats = { ...emptyEventStats(), initTs: 0, spawn: 2, taskCreate: 1 };
    const r = evaluateProtocolHealth({
      ...BASE_INPUT,
      stats,
      nowMs: NO_DELEGATION_GRACE_MS + 1,
    });
    const d = r.items.find((i) => i.check === "delegation")!;
    expect(d.status).toBe("available");
  });
});

describe("blackboard-silent 检测（义务声明前置）", () => {
  const required = ["researcher", "writer"];

  it("模板未声明义务 = not-applicable（确定性/判断性分离）", () => {
    const r = evaluateProtocolHealth(BASE_INPUT);
    const b = r.items.find((i) => i.check === "blackboard-silent")!;
    expect(b.status).toBe("not-applicable");
  });

  it("义务角色完成零黑板 = warning，豁免角色不触发", () => {
    const stats = emptyEventStats();
    stats.memberRoles.set("researcher-a1", "researcher");
    stats.memberRoles.set("reviewer-b2", "reviewer");
    stats.doneMembers.set("researcher-a1", 1);
    stats.doneMembers.set("reviewer-b2", 1);
    const r = evaluateProtocolHealth({ ...BASE_INPUT, blackboardRequiredRoles: required, stats });
    const b = r.items.find((i) => i.check === "blackboard-silent")!;
    expect(b.status).toBe("warning");
    expect(b.detail).toContain("researcher-a1");
    expect(b.detail).not.toContain("reviewer-b2");
  });

  it("反向：义务角色已写黑板 = available 不告警", () => {
    const stats = emptyEventStats();
    stats.memberRoles.set("researcher-a1", "researcher");
    stats.doneMembers.set("researcher-a1", 1);
    stats.blackboardMembers.set("researcher-a1", 4);
    const r = evaluateProtocolHealth({ ...BASE_INPUT, blackboardRequiredRoles: required, stats });
    const b = r.items.find((i) => i.check === "blackboard-silent")!;
    expect(b.status).toBe("available");
  });
});

describe("事件统计收集（collectEventStats）", () => {
  it("跨房间单遍聚合 kinds 计数、成员角色映射与 deviation 首检 seq", async () => {
    const home = mkdtempSync(join(tmpdir(), "xzg-ph-"));
    const roomsDir = join(home, "rooms");
    await seedEvents(roomsDir, "root", [
      { actor: "system", type: "team/init", payload: {} },
      { actor: "system", type: "team/spawn", payload: { member: "researcher-a1", role: "researcher" } },
      { actor: "system", type: DEVIATION_EVENT, payload: { check: "delegation" } },
    ]);
    await seedEvents(roomsDir, "researcher-a1", [
      { actor: "system", type: "task/create", payload: { task_id: "t1" } },
      { actor: "researcher-a1", type: "blackboard/set", payload: { status: "running" } },
      { actor: "researcher-a1", type: "task/update", payload: { status: "done" } },
    ]);
    const stats = await collectEventStats(roomsDir);
    expect(stats.spawn).toBe(1);
    expect(stats.taskCreate).toBe(1);
    expect(stats.deliver).toBe(0);
    expect(stats.memberRoles.get("researcher-a1")).toBe("researcher");
    expect(stats.doneMembers.get("researcher-a1")).toBe(1);
    expect(stats.blackboardMembers.get("researcher-a1")).toBe(1);
    expect(stats.deviations.get("delegation")).toBe(3);
    expect(stats.initTs).not.toBeNull();
    expect(stats.maxSeq).toBe(3);
  });

  it("无事件文件时返回零统计", async () => {
    const home = mkdtempSync(join(tmpdir(), "xzg-ph-empty-"));
    const stats = await collectEventStats(join(home, "rooms"));
    expect(stats.spawn).toBe(0);
    expect(stats.initTs).toBeNull();
    expect(stats.maxSeq).toBe(0);
  });
});

describe("brief 水印检测", () => {
  it("含水印 → true；master 补写 → false；文件缺失 → false", () => {
    const home = mkdtempSync(join(tmpdir(), "xzg-ph-wm-"));
    const briefDir = join(home, "rooms", "root", "brief");
    mkdirSync(briefDir, { recursive: true });
    expect(briefHasFrameworkMarker(home)).toBe(false);
    writeFileSync(join(briefDir, "user-request.md"), "master wrote this", "utf8");
    expect(briefHasFrameworkMarker(home)).toBe(false);
    writeFileSync(join(briefDir, "user-request.md"), `<!-- ${BRIEF_FRAMEWORK_MARKER}: x -->\n`, "utf8");
    expect(briefHasFrameworkMarker(home)).toBe(true);
  });
});
