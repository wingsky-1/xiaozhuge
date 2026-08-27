/**
 * team_send 可达性判定纯函数单测（#138）。
 * 覆盖：auto 树边判定（T1/T2/T3/T4）、explicit 白名单（T5）、树不变量
 * （多根/悬空/环/自指）、from==to 自发（盲区）、发件人 dangling 时 desc
 * 起点（盲区）、explicit 白名单 ⊆ 树边动态校验（硬伤修法 1）。
 */
import { describe, expect, it } from "vitest";
import {
  reachable,
  checkTree,
  ancestorsOf,
  descendantsOf,
} from "../../src/index.js";
import type { MemberRecord } from "../../src/index.js";

function member(name: string, parent?: string | null, tier = 1): MemberRecord {
  return {
    member: name,
    durableId: `dur-${name}`,
    parent: parent === undefined ? null : parent,
    tier,
    status: "running",
    lastSeen: Date.now(),
  };
}

/** 标准树：master(t0) → coder / qa；coder → painter（三代）。 */
function tree(): MemberRecord[] {
  return [
    member("master", null, 0),
    member("coder", "master"),
    member("qa", "master"),
    member("painter", "coder"),
  ];
}

describe("ancestorsOf / descendantsOf", () => {
  it("祖先闭包：painter → {painter, coder, master}", () => {
    const anc = ancestorsOf(tree(), "painter");
    expect([...anc].sort()).toEqual(["coder", "master", "painter"]);
  });

  it("后代闭包：master → 全员；coder → {coder, painter}", () => {
    const desc = descendantsOf(tree(), "master");
    expect([...desc].sort()).toEqual(["coder", "master", "painter", "qa"]);
    const descCoder = descendantsOf(tree(), "coder");
    expect([...descCoder].sort()).toEqual(["coder", "painter"]);
  });
});

describe("auto 模式可达性（T1-T4）", () => {
  it("T1 直系父↔子双向可达", () => {
    expect(reachable(tree(), "master", "coder").reachable).toBe(true);
    expect(reachable(tree(), "coder", "master").reachable).toBe(true);
  });

  it("T2 隔代祖先↔后代可达", () => {
    expect(reachable(tree(), "master", "painter").reachable).toBe(true);
    expect(reachable(tree(), "painter", "master").reachable).toBe(true);
  });

  it("T3 跨分支兄弟不可达（warning 含原因）", () => {
    const r = reachable(tree(), "coder", "qa");
    expect(r.reachable).toBe(false);
    expect(r.warnings.join(" ")).toContain("not ancestor-descendant");
  });

  it("T4 root↔任意成员可达（公共祖先，零特判）", () => {
    for (const m of ["coder", "qa", "painter"]) {
      expect(reachable(tree(), "master", m).reachable).toBe(true);
    }
  });
});

describe("explicit 模式（T5）", () => {
  const whitelist = [{ from: "master", to: "coder" }];

  it("T5 白名单内可达", () => {
    expect(reachable(tree(), "master", "coder", "explicit", whitelist).reachable).toBe(true);
  });

  it("T5 白名单外（树上相邻但未声明）不可达", () => {
    const r = reachable(tree(), "coder", "master", "explicit", whitelist);
    expect(r.reachable).toBe(false);
    expect(r.warnings.join(" ")).toContain("explicit whitelist has no coder->master edge");
  });

  it("T5 超树边声明 → 违规标注（硬伤修法 1：声明⊆树边动态校验）", () => {
    const r = reachable(tree(), "coder", "qa", "explicit", [{ from: "coder", to: "qa" }]);
    expect(r.reachable).toBe(true); // 白名单含该边 → 照常可达
    expect(r.warnings.join(" ")).toContain("is not a tree edge"); // 但声明超树边被标注
  });
});

describe("树不变量（B-应修-1）", () => {
  it("tier0 多根 → multi-root 违规", () => {
    const members = [member("r1", null, 0), member("r2", null, 0), member("c", "r1")];
    const v = checkTree(members);
    expect(v).toContain("multi-root");
    expect(reachable(members, "r1", "c").warnings.join(" ")).toContain("tree violation: multi-root");
  });

  it("非 tier0 parent 缺省 → parent-missing 违规（孤儿同款语义）", () => {
    const members = [member("master", null, 0), member("orphan")];
    const v = checkTree(members);
    expect(v).toContain("parent-missing");
    expect(v).not.toContain("multi-root");
  });

  it("无 tier0 根 → root-missing 违规", () => {
    const members = [member("a", "b"), member("b", "a")];
    const v = checkTree(members);
    expect(v).toContain("root-missing");
  });

  it("parent 悬空 → parent-dangling 违规", () => {
    const members = [member("master", null, 0), member("c", "ghost")];
    expect(checkTree(members)).toContain("parent-dangling");
  });

  it("环 → cycle 违规", () => {
    const members = [member("a", "b"), member("b", "c"), member("c", "a")];
    expect(checkTree(members)).toContain("cycle");
  });

  it("自指 → parent-self 违规", () => {
    const members = [member("master", null, 0), member("c", "c")];
    expect(checkTree(members)).toContain("parent-self");
  });
});

describe("盲区语义", () => {
  it("B-盲-1 from==to 自发恒可达（自查/自记）", () => {
    const r = reachable(tree(), "coder", "coder");
    expect(r.reachable).toBe(true);
  });

  it("B-盲-2 发件人 parent-dangling 时：anc 截断、desc 照常（向下发可达）", () => {
    // c 的 parent 悬空；c 有子 d。desc(c) 仍可算 → c→d 可达；c 的 anc 断在自身。
    const members = [member("master", null, 0), member("c", "ghost"), member("d", "c")];
    const r = reachable(members, "c", "d");
    expect(r.reachable).toBe(true);
    expect(r.warnings.join(" ")).toContain("parent-dangling");
    // c 向上发 master：anc 断链 → 不可达并标注（T6 语义）。
    const up = reachable(members, "c", "master");
    expect(up.reachable).toBe(false);
  });
});

describe("健康树零标注", () => {
  it("标准树任意可达对 warnings 为空（固定 schema 恒在场）", () => {
    const r = reachable(tree(), "master", "painter");
    expect(r.warnings).toEqual([]);
    expect(r.violations).toEqual([]);
  });
});
