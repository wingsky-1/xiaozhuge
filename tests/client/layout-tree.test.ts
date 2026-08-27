/**
 * layoutTree 响应式布局单测（#144 A4-7）。
 *
 * 纯函数测试：dagre 布局不依赖 DOM，直接断言 LR/TB 双形态的坐标方向与
 * Handle 方向数据透传（node.data.rankdir 由 MemberNodeCard 消费）。
 */
import { describe, expect, it } from "vitest";
import { layoutTree, buildTree } from "../../src/client/team-view.js";

/** 构造一棵两层树：root → a / b；a → a1。 */
function sampleMembers(): Array<{
  member: string;
  tier: number;
  parent: string | null;
  durableId: string;
  registryStatus: string;
  tone: string;
  currentActivity: string | null;
  lastSeen: number;
}> {
  return [
    { member: "root", tier: 0, parent: null, durableId: "d0", registryStatus: "running", tone: "running", currentActivity: null, lastSeen: 1 },
    { member: "a", tier: 1, parent: "root", durableId: "d1", registryStatus: "running", tone: "idle", currentActivity: null, lastSeen: 2 },
    { member: "b", tier: 1, parent: "root", durableId: "d2", registryStatus: "running", tone: "idle", currentActivity: null, lastSeen: 3 },
    { member: "a1", tier: 2, parent: "a", durableId: "d3", registryStatus: "running", tone: "idle", currentActivity: null, lastSeen: 4 },
  ];
}

function pos(nodes: ReturnType<typeof layoutTree>["nodes"], id: string): { x: number; y: number } {
  const n = nodes.find((n) => n.id === id);
  if (n === undefined) throw new Error(`node ${id} not found`);
  return n.position;
}

describe("layoutTree 响应式 rankdir（A4-7）", () => {
  it("TB：层级沿 y 轴（根 y 最小，叶 y 最大），x 为同级分布", () => {
    const tree = buildTree(sampleMembers());
    const { nodes } = layoutTree(tree, { rankdir: "TB" });
    const root = pos(nodes, "root");
    const a = pos(nodes, "a");
    const a1 = pos(nodes, "a1");
    // 根在上、孙在下：y 逐层递增。
    expect(a1.y).toBeGreaterThan(a.y);
    expect(a.y).toBeGreaterThan(root.y);
    // a/b 同级：y 相近（垂直分布），x 不同。
    const b = pos(nodes, "b");
    expect(Math.abs(a.y - b.y)).toBeLessThan(10);
    expect(a.x).not.toBe(b.x);
  });

  it("LR：层级沿 x 轴（根 x 最小，叶 x 最大），y 为同级分布", () => {
    const tree = buildTree(sampleMembers());
    const { nodes } = layoutTree(tree, { rankdir: "LR" });
    const root = pos(nodes, "root");
    const a = pos(nodes, "a");
    const a1 = pos(nodes, "a1");
    // 根在左、孙在右：x 逐层递增。
    expect(a.x).toBeGreaterThan(root.x);
    expect(a1.x).toBeGreaterThan(a.x);
    // a/b 同级：y 不同（垂直分布），x 相近。
    const b = pos(nodes, "b");
    expect(Math.abs(a.x - b.x)).toBeLessThan(10);
    expect(a.y).not.toBe(b.y);
  });

  it("nodes 数据透传 rankdir（MemberNodeCard Handle 方向消费）", () => {
    const tree = buildTree(sampleMembers());
    const { nodes: tbNodes } = layoutTree(tree, { rankdir: "TB" });
    const { nodes: lrNodes } = layoutTree(tree, { rankdir: "LR" });
    for (const n of tbNodes) {
      expect((n.data as { rankdir: string }).rankdir).toBe("TB");
    }
    for (const n of lrNodes) {
      expect((n.data as { rankdir: string }).rankdir).toBe("LR");
    }
  });

  it("边方向：父→子 source→target 恒正确（LR/TB 一致）", () => {
    const tree = buildTree(sampleMembers());
    for (const rankdir of ["TB", "LR"] as const) {
      const { edges } = layoutTree(tree, { rankdir });
      const e = edges.find((e) => e.source === "root" && e.target === "a");
      expect(e).toBeDefined();
      expect(edges.find((e) => e.source === "a" && e.target === "root")).toBeUndefined();
    }
  });
});
