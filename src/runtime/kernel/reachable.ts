/**
 * team_send 可达性判定纯函数（#138，report-only 过渡档）。
 *
 * 构图：注册表成员为节点，每条非空 parent 记一条无向边 (parent, m)——通信
 * 沿父子边双向（委托下行、上报上行、经父中继，10-generic-model.md:61；
 * 不变量 3「拓扑为树、消息走父子边」）。
 *
 * auto 模式：reachable(from,to) ⟺ to ∈ anc(from) ∪ desc(from)。
 * explicit 模式：白名单边 from→to 方可通（收窄语义，10:62）。
 *
 * 本模块同时承载评审新增的树不变量前置校验（#138 B-应修-1）与 explicit
 * 白名单 ⊆ 树边动态校验（#138 B-硬伤-1 修法 1）：父链缺/悬空/多根/环在
 * report-only 档语义下不抛错，而以标注形式暴露（与 orphan_members 数据
 * 互补，硬校验待 #96 数据产出后另行立项）。
 */
import type { MemberRecord } from "./types.js";

export type CommMode = "auto" | "explicit";

/** explicit 白名单单条边（from→to 单向；方向语义 #138 B-应修-2）。 */
export interface CommEdge {
  from: string;
  to: string;
}

/** 树不变量违规分类（report-only 标注 reason 用）。 */
export type TreeViolation =
  | "root-missing"       // 无 tier0 无父主控
  | "multi-root"         // tier0 无父主控多于一个（单入口原则，handlers.ts:815）
  | "parent-missing"     // 非 tier0 成员 parent 缺省（孤儿标红同款，handlers.ts:813-824）
  | "parent-dangling"    // parent 未在册
  | "cycle"              // 沿 parent 链上溯回到已访问节点
  | "parent-self";       // parent 指向自身

/** 可达性判定结果（report-only：不抛错，违规以 violations 标注）。 */
export interface ReachabilityResult {
  reachable: boolean;
  /** 不可达/违规的原因；可达且无违规时为空数组。 */
  warnings: string[];
  /** 树不变量违规清单（auto/explicit 共用；空数组 = 树健康）。 */
  violations: TreeViolation[];
}

/** 成员 → 其直接子成员集（children 邻接表）。 */
export function childrenOf(members: readonly MemberRecord[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const m of members) {
    if (m.parent !== undefined && m.parent !== null && m.parent !== m.member) {
      const list = children.get(m.parent) ?? [];
      list.push(m.member);
      children.set(m.parent, list);
    }
  }
  return children;
}

/** 沿 parent 链上溯至根的闭包（含自身；环/悬空时截断到已存在链）。 */
export function ancestorsOf(members: readonly MemberRecord[], from: string): Set<string> {
  const byName = new Map(members.map((m) => [m.member, m] as const));
  const seen = new Set<string>();
  let cur: string | undefined = from;
  while (cur !== undefined) {
    if (seen.has(cur)) break; // 环保护：重复即停
    seen.add(cur);
    const rec = byName.get(cur);
    if (rec === undefined) break; // 悬空/未在册：截断
    const p = rec.parent;
    cur = p === undefined || p === null || p === rec.member ? undefined : p;
  }
  return seen;
}

/** 由 from 出发经 children BFS 的子树闭包（含自身）。 */
export function descendantsOf(members: readonly MemberRecord[], from: string): Set<string> {
  const children = childrenOf(members);
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const child of children.get(cur) ?? []) queue.push(child);
  }
  return seen;
}

/** 树不变量校验（B-应修-1）：tier0 根唯一、非根 parent 必填且在册、无环、无自指。 */
export function checkTree(members: readonly MemberRecord[]): TreeViolation[] {
  const violations: TreeViolation[] = [];
  const byName = new Map(members.map((m) => [m.member, m] as const));
  // 单入口原则（handlers.ts:815）：有且仅有一个 tier0 无父主控。
  const tier0Roots = members.filter(
    (m) => m.tier === 0 && (m.parent === undefined || m.parent === null),
  );
  if (tier0Roots.length === 0) violations.push("root-missing");
  if (tier0Roots.length > 1) violations.push("multi-root");
  for (const m of members) {
    const p = m.parent;
    if (p === undefined || p === null) {
      // 非 tier0 成员缺 parent = parent-missing（孤儿标红同款语义）。
      if (m.tier !== 0) violations.push("parent-missing");
      continue;
    }
    if (p === m.member) {
      violations.push("parent-self");
      continue;
    }
    if (!byName.has(p)) {
      violations.push("parent-dangling");
      continue;
    }
    // 环检测：从该节点沿 parent 链上溯，重复即环。
    const seen = new Set<string>();
    let cur: string | undefined = m.member;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      const rec = byName.get(cur);
      if (rec === undefined) break;
      const np = rec.parent;
      cur = np === undefined || np === null || np === rec.member ? undefined : np;
    }
    if (cur !== undefined) violations.push("cycle");
  }
  // 去重（同环多节点各自检出；保留首见即可）
  return [...new Set(violations)];
}

/**
 * 可达性判定。
 * @param members 注册表成员全量
 * @param from    发件人（requireSelf 已保证其真实性，但可能 dangling）
 * @param to      收件人（调用方已先做在册检查；此处仍防御）
 * @param mode    comm_mode（缺省 auto）
 * @param comm    explicit 白名单边
 */
export function reachable(
  members: readonly MemberRecord[],
  from: string,
  to: string,
  mode: CommMode = "auto",
  comm: readonly CommEdge[] = [],
): ReachabilityResult {
  const warnings: string[] = [];
  const violations = checkTree(members);
  for (const v of violations) {
    warnings.push(`tree violation: ${v}`);
  }

  if (from === to) {
    // B-盲-1：from==to 自发恒可达（自查/自记），显式锚定。
    return { reachable: true, warnings, violations };
  }

  if (mode === "explicit") {
    // B-硬伤-1 修法 1：白名单边 ⊆ 树边动态校验——explicit 声明的边必须是
    // 当前成员树的父子边（auto 可达语义即树上连通）；超树边声明即违规标注。
    const treeAdj = new Set<string>();
    for (const m of members) {
      if (m.parent !== undefined && m.parent !== null && m.parent !== m.member) {
        treeAdj.add(`${m.parent}->${m.member}`);
        treeAdj.add(`${m.member}->${m.parent}`);
      }
    }
    for (const edge of comm) {
      if (!treeAdj.has(`${edge.from}->${edge.to}`)) {
        warnings.push(`explicit edge ${edge.from}->${edge.to} is not a tree edge`);
      }
    }
    const ok = comm.some((e) => e.from === from && e.to === to);
    if (!ok) warnings.push(`explicit whitelist has no ${from}->${to} edge`);
    return { reachable: ok, warnings, violations };
  }

  // auto：树上两点连通当且仅当互为祖先-后代。
  const anc = ancestorsOf(members, from);
  const desc = descendantsOf(members, from);
  const ok = anc.has(to) || desc.has(to);
  if (!ok) warnings.push(`${from} and ${to} are not ancestor-descendant on the member tree`);
  return { reachable: ok, warnings, violations };
}
