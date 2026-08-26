/**
 * 视图供数解析单测（#97 问题 3）：主会话直查优先；子会话按成员 durable id
 * 反查所属实例（纯读）；未初始化实例不命中、损坏注册表跳过、DSH_HOME 隔离。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTeamHomeForView } from "../../src/plugin/team-home.js";

let home: string;
let dshHome: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "xzg-teamhome-"));
  dshHome = join(home, "dsh-home");
  process.env.DSH_HOME = dshHome;
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
    expect(r.membership).toEqual({ rootSession: "s-root", member: "coder" });
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
    expect(r.membership).toEqual({ rootSession: "s-good", member: "writer" });
  });

  it("完全未知会话 → 回落直查路径，membership=null 不抛错", () => {
    const r = resolveTeamHomeForView("s-nowhere");
    expect(r.membership).toBeNull();
  });
});
