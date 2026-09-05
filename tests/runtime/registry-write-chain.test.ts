import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../../src/runtime/kernel/registry.js";
import type { MemberRecord } from "../../src/runtime/kernel/types.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "xzg-registry-chain-"));
}

function member(name: string, durableId: string): MemberRecord {
  return {
    member: name,
    durableId,
    role: "coder",
    tier: 1,
    parent: "master",
    status: "running",
    lastSeen: Date.now(),
  };
}

/**
 * P0-1（issue #180）：agents.json 进程内写链——主控与子代理各自持有独立
 * Registry 实例（host.ts 每会话 handler 集独立注册表）共享同一 TEAM_HOME，
 * 并发 RMW 此前基于旧快照覆盖写会整条丢成员记录；写链串行化后不丢。
 */
describe("Registry 进程内写链（P0-1，#180）", () => {
  it("两个实例并发 upsertMember（不同成员）不丢记录", async () => {
    const home = tmpHome();
    const a = new Registry(home);
    const b = new Registry(home);
    await Promise.all([
      a.upsertMember(member("m1", "d1")),
      b.upsertMember(member("m2", "d2")),
      a.upsertMember(member("m3", "d3")),
      b.upsertMember(member("m4", "d4")),
      a.upsertMember(member("m5", "d5")),
    ]);
    const reg = await a.read();
    expect(Object.keys(reg.members).sort()).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  it("upsertMember 与 touchMember 并发交错：成员不丢、lastSeen 推进且不覆于旧值", async () => {
    const home = tmpHome();
    const a = new Registry(home);
    const b = new Registry(home);
    await a.upsertMember(member("m1", "d1"));
    const base = (await a.read()).members["m1"]!.lastSeen;
    // 交错：多次心跳（可能写旧 lastSeen）与一次新增并发——写链保证
    // 心跳 RMW 读到的都是最新注册表，m2 登记绝不因心跳旧快照被吞。
    await Promise.all([
      ...Array.from({ length: 16 }, () => b.touchMember("m1")),
      a.upsertMember(member("m2", "d2")),
      ...Array.from({ length: 8 }, () => a.touchMember("m1")),
    ]);
    const reg = await a.read();
    expect(Object.keys(reg.members).sort()).toEqual(["m1", "m2"]);
    // 心跳全部基于写链内最新快照：即使并发交错，lastSeen 也不应回退到
    // 初始值（写链内 Date.now() 单调；仅要求 ≥ base）。
    expect(reg.members["m1"]!.lastSeen).toBeGreaterThanOrEqual(base);
    expect(reg.members["m2"]!.status).toBe("running");
  });

  it("setStatus 与 upsertMember 并发：状态迁移与新增登记均落盘", async () => {
    const home = tmpHome();
    const a = new Registry(home);
    const b = new Registry(home);
    await a.upsertMember(member("m1", "d1"));
    await Promise.all([
      a.setStatus("m1", "done"),
      b.upsertMember(member("m2", "d2")),
      a.setStatus("m1", "dead"),
    ]);
    const reg = await a.read();
    expect(reg.members["m1"]!.status).toBe("dead");
    expect(reg.members["m2"]).toBeDefined();
  });

  it("写链任务失败不阻断后续写（队列用 catch 续链）", async () => {
    const home = tmpHome();
    const a = new Registry(home);
    const b = new Registry(home);
    await expect(a.setStatus("ghost", "dead")).rejects.toThrow(/not registered/);
    // 失败后链仍可用：后续 upsertMember 正常执行。
    await b.upsertMember(member("m1", "d1"));
    const reg = await a.read();
    expect(reg.members["m1"]).toBeDefined();
  });
});