/**
 * 视图供数解析单测（#97 问题 3）：主会话直查优先；子会话按成员 durable id
 * 反查所属实例（纯读）；未初始化实例不命中、损坏注册表跳过、DSH_HOME 隔离。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTeamHomeForView } from "../../src/plugin/team-home.js";
import { resetSessionIndex } from "../../src/plugin/session-index.js";

let home: string;
let dshHome: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "xzg-teamhome-"));
  dshHome = join(home, "dsh-home");
  process.env.DSH_HOME = dshHome;
});

afterEach(() => {
  // 索引单例按 DSH_HOME 隔离；逐用例清理防 fd/状态跨用例累积（ADR 0021）。
  resetSessionIndex();
});

/** 在 DSH_HOME 下落一个实例：<sessions>/<rootSession>/{team.yaml, agents.json}。 */
function makeInstance(
  rootSession: string,
  members: Record<string, { member: string; durableId?: string }>,
  opts: { withTeamYaml?: boolean; corruptAgents?: boolean } = {},
): string {
  const dir = join(dshHome, "xiaozhuge", "sessions", rootSession);
  mkdirSync(dir, { recursive: true });
  if (opts.withTeamYaml !== false) {
    writeFileSync(join(dir, "team.yaml"), JSON.stringify({ name: "demo", playbook_digest: "x" }));
  }
  if (opts.corruptAgents) {
    writeFileSync(join(dir, "agents.json"), "{ not json");
  } else {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ members }));
  }
  return dir;
}

describe("resolveTeamHomeForView", () => {
  it("主会话直查优先：team.yaml 在场 → membership=null", () => {
    makeInstance("s-root", { master: { member: "master", durableId: "s-root" } });
    const r = resolveTeamHomeForView("s-root");
    expect(r.membership).toBeNull();
    expect(r.teamHome).toBe(join(dshHome, "xiaozhuge", "sessions", "s-root"));
  });

  it("子会话反查命中：durableId 匹配成员 → 返回归属实例与成员名", () => {
    makeInstance("s-root", {
      master: { member: "master", durableId: "s-root" },
      coder: { member: "coder", durableId: "dur-c1" },
    });
    const r = resolveTeamHomeForView("dur-c1");
    expect(r.membership).toEqual({ root_session: "s-root", member: "coder" });
    expect(r.teamHome).toBe(join(dshHome, "xiaozhuge", "sessions", "s-root"));
  });

  it("成员所在实例未初始化（team.yaml 不在）→ 不命中，membership=null", () => {
    makeInstance("s-root", { coder: { member: "coder", durableId: "dur-c1" } }, { withTeamYaml: false });
    const r = resolveTeamHomeForView("dur-c1");
    expect(r.membership).toBeNull();
  });

  it("损坏注册表跳过继续扫，不影响后续实例命中", () => {
    makeInstance("s-bad", {}, { corruptAgents: true });
    makeInstance("s-good", { writer: { member: "writer", durableId: "dur-w1" } });
    const r = resolveTeamHomeForView("dur-w1");
    expect(r.membership).toEqual({ root_session: "s-good", member: "writer" });
  });

  it("完全未知会话 → 回落直查路径，membership=null 不抛错", () => {
    const r = resolveTeamHomeForView("s-nowhere");
    expect(r.membership).toBeNull();
  });

  it("负缓存过期后：同一未知 id 重新全扫（TTL 窗口外不再免扫）", () => {
    // 首次 miss 登记负缓存（短窗免扫）
    expect(resolveTeamHomeForView("dur-exp").membership).toBeNull();
    // 同窗内二次 miss：不重复全扫（仍回落直查 null）
    expect(resolveTeamHomeForView("dur-exp").membership).toBeNull();
    // 推进系统时间越过 TTL（30s）→ 过期条目被清理，重新全扫（结果不变）
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 31_000);
    try {
      expect(resolveTeamHomeForView("dur-exp").membership).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
