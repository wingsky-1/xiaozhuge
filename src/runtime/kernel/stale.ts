/**
 * stale 心跳判定共享纯函数（#194 F5-2 双镜像收敛）。
 *
 * 唯一实现：src/plugin/handlers.ts reconcile 标注段与 src/runtime/view/detail.ts
 * staleAnnotations 此前是同一口径的两套镜像（靠注释「R4 双向同步」+ 测试锚定
 * 防漂移），本函数抽出后两侧共消费，判定规则单点维护。
 *
 * 口径逐条对齐 ADR 0016（与既有双侧实现一致，行为零变化）：
 * - 候选 = tier ≠ 0 且 status === "running" 且 Number.isFinite(lastSeen)
 *   （dead 一律不收录——lost 着色已表达防双计；spawned/stopped 非干活中）；
 * - 超阈判定 nowMs - lastSeen > STALE_THRESHOLD_MS 严格大于（恰达阈值不算；
 *   时钟回拨负 age 天然不超阈，无需特判）；
 * - 存在任一房间 status === "blocked" 分片者归 awaitingInput 免责档
 *   （等待输入 ≠ 停摆），否则入 staleMembers；
 * - tier0 不入两个名单：超阈单独置 masterIdle = true；注册表无 tier0 成员或
 *   其 lastSeen 非有限 → 恒 false；
 * - 两名单均按 member localeCompare 升序输出。
 */
import { STALE_THRESHOLD_MS, type MemberRecord } from "./types.js";

/** stale / awaiting_input 名册条目（reconcile last_seen_age_ms 与视图 lastSeenAgeMs 同构）。 */
export interface StaleMemberAnnotation {
  member: string;
  lastSeenAgeMs: number;
}

export interface StaleVerdict {
  masterIdle: boolean;
  staleMembers: StaleMemberAnnotation[];
  awaitingInput: StaleMemberAnnotation[];
}

/**
 * 注册表 + 黑板 blocked 分片角色集 → 三项 stale 标注。
 * blockedRoles = 任一房间 status === "blocked" 分片的成员名集合（调用方聚合）。
 */
export function staleVerdict(
  members: readonly MemberRecord[],
  blockedRoles: ReadonlySet<string>,
  nowMs: number,
): StaleVerdict {
  const candidates = members.filter(
    (m) => m.tier !== 0 && m.status === "running" && Number.isFinite(m.lastSeen),
  );
  const annotate = (m: MemberRecord): StaleMemberAnnotation => ({
    member: m.member,
    lastSeenAgeMs: nowMs - m.lastSeen,
  });
  const byNameAsc = (a: { member: string }, b: { member: string }): number =>
    a.member.localeCompare(b.member);
  const overThreshold = (m: MemberRecord): boolean => nowMs - m.lastSeen > STALE_THRESHOLD_MS;
  const tier0Master = members.find((m) => m.tier === 0);
  return {
    masterIdle:
      tier0Master !== undefined &&
      Number.isFinite(tier0Master.lastSeen) &&
      nowMs - tier0Master.lastSeen > STALE_THRESHOLD_MS,
    staleMembers: candidates
      .filter((m) => overThreshold(m) && !blockedRoles.has(m.member))
      .map(annotate)
      .sort(byNameAsc),
    awaitingInput: candidates
      .filter((m) => overThreshold(m) && blockedRoles.has(m.member))
      .map(annotate)
      .sort(byNameAsc),
  };
}
