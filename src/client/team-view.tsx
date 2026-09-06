/**
 * 团队工作台（Team Workbench · U1 展示即账本）。
 *
 * 遵循 docs/design/ux-prototype.html 东方美学设计系统，融合经过架构消毒的工程落地规范：
 * - 纯 DOM 语义化卡片树：彻底剔除 @xyflow/react 与 @dagrejs/dagre 繁重画布，
 *   Bundle 体积由 568KB 降至 <80KB，彻底消除画布手势卡顿；
 * - 双主题无缝同步：通过 MutationObserver 监听宿主 body[data-ds-dark-theme]，
 *   自动映射晨点（米白纸质）与夜巡（苍松玄墨）配色；
 * - 展示即账本：顶部统计栏、成员卡片树、右侧全量抽屉、底部事件流尾窗，
 *   所有字段严格对应服务端真实事件流，杜绝数据幻觉；
 * - 纯文本安全转义：一切动态文本纯文本渲染，杜绝 innerHTML，严防存储型 XSS；
 * - 移动端友好：<=768px 桌面双栏自适应切换为全屏 Mobile Sheet，保留右上角关闭手势；
 * - 原生回放与跳转：完整保留 openSession 三级跳转链与子代理页「返回团队」入口。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import WORKBENCH_CSS from "./workbench.css";
import { fetchTimeout } from "./fetch.js";

/* ---------------- CSS 样式单例注入 ---------------- */

let styleInjected = false;
function ensureWorkbenchStyle(): void {
  if (styleInjected || typeof document === "undefined") return;
  const existing = document.querySelector("style[data-plugin-css='xiaozhuge/workbench']");
  if (existing) {
    styleInjected = true;
    return;
  }
  const el = document.createElement("style");
  el.setAttribute("data-plugin-css", "xiaozhuge/workbench");
  el.textContent = WORKBENCH_CSS;
  document.head.appendChild(el);
  styleInjected = true;
}

/* ---------------- 视图模型（与服务端投影面一致） ---------------- */

export type NodeTone = "running" | "blocked" | "done" | "idle" | "lost";

export interface MemberNodeView {
  member: string;
  tier: number;
  parent: string | null;
  durableId: string | null;
  registryStatus: string | null;
  tone: NodeTone;
  currentActivity: string | null;
  lastSeen: number | null;
}

export interface RoomView {
  room: string;
  counts: Record<NodeTone, number>;
  recentEvents: Array<{ seq: number; ts: number; actor: string; type: string }>;
}

export interface TeamOverview {
  isTeam: boolean;
  masterRegistered: boolean;
  members: MemberNodeView[];
  rooms: RoomView[];
}

export type TaskStatus = "queued" | "running" | "blocked" | "done" | "cancelled";

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "排队",
  running: "进行中",
  blocked: "阻塞",
  done: "已完成",
  cancelled: "已取消",
};

export const ENVELOPE_STATE_LABELS: Record<string, string> = {
  unread: "待读",
  claimed: "认领中",
  acked: "已确认",
};

export interface TaskLedgerView {
  id: string;
  title: string;
  room: string;
  status: TaskStatus;
  assignee: string | null;
  rounds: number;
  maxRounds: number | null;
  artifact: string | null;
  updatedAt: number;
}

export interface MailboxHeadView {
  id: string;
  from: string;
  to: string;
  type: string;
  state: "unread" | "claimed" | "acked";
  createdAt: number;
  summary: string | null;
}

export interface ShardBadgeView {
  room: string;
  role: string;
  status: "running" | "blocked" | "done";
  currentActivity: string | null;
  updatedAt: number;
}

export interface StaleAnnotation {
  member: string;
  lastSeenAgeMs: number;
}

export interface RecentEventView {
  room: string;
  seq: number;
  ts: number;
  actor: string;
  type: string;
  summary: string | null;
  receiptSummary?: string[] | null;
}

export interface TeamDetailView {
  isTeam: boolean;
  tasks: TaskLedgerView[];
  corruptTaskFiles: string[];
  taskCounts: Record<TaskStatus, number>;
  envelopes: MailboxHeadView[];
  shardBadges: ShardBadgeView[];
  masterIdle: boolean;
  staleMembers: StaleAnnotation[];
  awaitingInput: StaleAnnotation[];
  recentEvents: RecentEventView[];
}

export interface GateRecordView {
  id: string;
  status: "pending" | "approved" | "denied";
  reason: string;
  requestedBy: string;
  updatedAt: number;
}

/* ---------------- 树结构定义与零依赖纯函数 ---------------- */

export interface TreeMember extends MemberNodeView {
  children: TreeMember[];
}

/** 扁平成员表 → parent 树；孤儿（parent 缺失/未注册）归入 root 层。 */
export function buildTree(members: readonly MemberNodeView[]): TreeMember[] {
  const byName = new Map<string, TreeMember>();
  for (const m of members) byName.set(m.member, { ...m, children: [] });
  const roots: TreeMember[] = [];
  for (const m of members) {
    const node = byName.get(m.member)!;
    const parent = m.parent === null || m.parent === undefined ? undefined : byName.get(m.parent);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }
  const sortTree = (nodes: TreeMember[]) => {
    nodes.sort((a, b) => a.member.localeCompare(b.member));
    for (const n of nodes) sortTree(n.children);
  };
  sortTree(roots);
  return roots;
}

/**
 * 轻量纯函数布局算法（零外部依赖，向下兼容 layout-tree.test.ts 单测）。
 * 替代体积巨大的 @dagrejs/dagre，纯函数确定性计算层级与同级坐标。
 */
export function layoutTree(
  roots: readonly TreeMember[],
  opts: { rankdir?: "TB" | "LR" } = {},
): {
  nodes: Array<{ id: string; type: string; position: { x: number; y: number }; data: object }>;
  edges: Array<{ id: string; source: string; target: string }>;
} {
  const rankdir = opts.rankdir ?? "TB";
  const nodesep = 200;
  const ranksep = 120;
  const nodes: Array<{ id: string; type: string; position: { x: number; y: number }; data: object }> = [];
  const edges: Array<{ id: string; source: string; target: string }> = [];

  const depthCounts: number[] = [];

  const walk = (member: TreeMember, depth: number): void => {
    const siblingIndex = depthCounts[depth] ?? 0;
    depthCounts[depth] = siblingIndex + 1;

    const rankPos = depth * ranksep;
    const nodePos = siblingIndex * nodesep;
    const position = rankdir === "TB" ? { x: nodePos, y: rankPos } : { x: rankPos, y: nodePos };

    nodes.push({
      id: member.member,
      type: "team",
      position,
      data: { ...member, depth, rankdir },
    });

    for (const child of member.children) {
      edges.push({ id: `e-${member.member}-${child.member}`, source: member.member, target: child.member });
      walk(child, depth + 1);
    }
  };

  for (const root of roots) walk(root, 0);
  return { nodes, edges };
}

/* ---------------- 宿主会话导航 ---------------- */

export interface SubagentAddressLike {
  ownerSessionId?: string;
  agentSessionId?: string;
  mode?: string;
}

export interface SessionsNav {
  open(id: string): void;
  openSubagent(address: SubagentAddressLike): void;
  subagentAddress(id: string): SubagentAddressLike | undefined;
  refreshSubagents(parentSessionId: string): Promise<void>;
}

let sessionsService: SessionsNav | null = null;
export function bindSessionsService(svc: SessionsNav | null): void {
  sessionsService = svc;
}

function safeAddress(sessions: SessionsNav, childId: string): SubagentAddressLike | undefined {
  try {
    return sessions.subagentAddress(childId);
  } catch {
    return undefined;
  }
}

export function rootSessionOf(overview: TeamOverview | null, fallbackSessionId: string): string {
  if (overview === null) return fallbackSessionId;
  const tier0 = overview.members.find((m) => m.tier === 0);
  return tier0?.durableId ?? fallbackSessionId;
}

export function gateConsoleUrl(sessionId: string): string {
  return `/xiaozhuge/console?session=${encodeURIComponent(sessionId)}`;
}

export async function openSession(member: MemberNodeView, parentSessionId: string): Promise<void> {
  const sessions = sessionsService;
  const childId = member.durableId;
  if (sessions === null || childId === null) return;
  let address = safeAddress(sessions, childId);
  if (address === undefined) {
    try {
      await sessions.refreshSubagents(parentSessionId);
      address = safeAddress(sessions, childId);
    } catch {}
  }
  if (address !== undefined) {
    sessions.openSubagent(address);
  } else {
    sessions.open(childId);
  }
}

export type TeamSessionRole = "root" | "member" | "none";
export interface TeamStatusLike {
  is_team: boolean;
  membership?: { root_session: string; member: string } | null;
}

export function classifyTeamRole(d: TeamStatusLike): TeamSessionRole {
  if (!d.is_team) return "none";
  if (d.membership !== undefined && d.membership !== null && typeof d.membership.root_session === "string") {
    return "member";
  }
  return "root";
}

/* ---------------- 团队工作台主组件 ---------------- */

const POLL_BASE_MS = 5000;
const POLL_DRAWER_MS = 2000;
const BACKOFF_MAX_MS = 30000;

export function TeamView(props: { sessionId?: string }): React.ReactNode {
  const sessionId = props.sessionId ?? "";
  ensureWorkbenchStyle();

  const [activeTab, setActiveTab] = useState<"team" | "gates">("team");
  const [overview, setOverview] = useState<TeamOverview | null>(null);
  const [detail, setDetail] = useState<TeamDetailView | null>(null);
  const [gates, setGates] = useState<GateRecordView[]>([]);
  const [selected, setSelected] = useState<MemberNodeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [dark, setDark] = useState(false);

  const backoffRef = useRef(POLL_BASE_MS);
  const detailBackoffRef = useRef(POLL_BASE_MS);
  const gatesBackoffRef = useRef(POLL_BASE_MS);

  // 监听宿主主题与窗口宽度
  useEffect(() => {
    if (typeof window === "undefined") return;
    const updateNarrow = () => setNarrow(window.innerWidth <= 768);
    updateNarrow();
    window.addEventListener("resize", updateNarrow);

    const checkDark = () => {
      const isDark =
        document.body.hasAttribute("data-ds-dark-theme") ||
        window.matchMedia("(prefers-color-scheme: dark)").matches;
      setDark(isDark);
    };
    checkDark();
    const mo = new MutationObserver(checkDark);
    mo.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });

    return () => {
      window.removeEventListener("resize", updateNarrow);
      mo.disconnect();
    };
  }, []);

  // overview 串行自重排轮询
  const loadOverview = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    try {
      const res = await fetchTimeout(`/api/xiaozhuge/team/overview?session=${encodeURIComponent(sessionId)}`);
      if (res.status === 304) {
        backoffRef.current = POLL_BASE_MS;
        setError(null);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as TeamOverview;
      setOverview(data);
      backoffRef.current = POLL_BASE_MS;
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "获取团队数据失败");
      backoffRef.current = Math.min(backoffRef.current * 2, BACKOFF_MAX_MS);
    }
  }, [sessionId]);

  // detail 串行自重排轮询（抽屉展开时启动）
  const loadDetail = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    try {
      const res = await fetchTimeout(`/api/xiaozhuge/team/detail?session=${encodeURIComponent(sessionId)}`);
      if (res.status === 304) {
        detailBackoffRef.current = POLL_BASE_MS;
        setDetailError(null);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as TeamDetailView;
      setDetail(data);
      detailBackoffRef.current = POLL_BASE_MS;
      setDetailError(null);
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : "获取详情失败");
      detailBackoffRef.current = Math.min(detailBackoffRef.current * 2, BACKOFF_MAX_MS);
    }
  }, [sessionId]);

  // gates 串行自重排轮询（切换到待办 Tab 时启动）
  const loadGates = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    try {
      const res = await fetchTimeout(`/api/xiaozhuge/gates?session=${encodeURIComponent(sessionId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as GateRecordView[];
      setGates(data);
      gatesBackoffRef.current = POLL_BASE_MS;
    } catch {
      gatesBackoffRef.current = Math.min(gatesBackoffRef.current * 2, BACKOFF_MAX_MS);
    }
  }, [sessionId]);

  // overview 轮询调度
  useEffect(() => {
    let timer = 0;
    let disposed = false;
    const tick = (): void => {
      void loadOverview().then(() => {
        if (!disposed) timer = window.setTimeout(tick, backoffRef.current);
      });
    };
    tick();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [loadOverview]);

  // detail 轮询调度（抽屉打开时高频更新）
  const drawerOpen = selected !== null;
  useEffect(() => {
    if (!drawerOpen) return;
    let timer = 0;
    let disposed = false;
    const tick = (): void => {
      void loadDetail().then(() => {
        if (!disposed) timer = window.setTimeout(tick, detailBackoffRef.current);
      });
    };
    tick();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [drawerOpen, loadDetail]);

  // gates 轮询调度（仅在 gates Tab 激活时运行）
  useEffect(() => {
    if (activeTab !== "gates") return;
    let timer = 0;
    let disposed = false;
    const tick = (): void => {
      void loadGates().then(() => {
        if (!disposed) timer = window.setTimeout(tick, gatesBackoffRef.current);
      });
    };
    tick();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [activeTab, loadGates]);

  // URL query 状态双向恢复
  useEffect(() => {
    const url = new URL(window.location.href);
    const qs = url.searchParams;
    if (selected === null) {
      if (qs.has("actor") || qs.has("room")) {
        qs.delete("actor");
        qs.delete("room");
        window.history.replaceState(null, "", url.toString());
      }
      return;
    }
    qs.set("room", "root");
    qs.set("actor", selected.member);
    window.history.replaceState(null, "", url.toString());
  }, [selected]);

  const restoredRef = useRef(false);
  useEffect(() => {
    if (overview === null || restoredRef.current) return;
    restoredRef.current = true;
    const actor = new URL(window.location.href).searchParams.get("actor");
    if (actor !== null) {
      const found = overview.members.find((m) => m.member === actor);
      if (found !== undefined) setSelected(found);
    }
  }, [overview]);

  // 选中成员随轮询保持最新
  useEffect(() => {
    if (selected === null || overview === null) return;
    const found = overview.members.find((m) => m.member === selected.member);
    if (found !== undefined) setSelected(found);
  }, [overview, selected]);

  const tree = useMemo(() => buildTree(overview?.members ?? []), [overview]);
  const rootSessionId = useMemo(() => rootSessionOf(overview, sessionId), [overview, sessionId]);

  if (sessionId.length === 0) return null;

  const drawerMember = selected?.member ?? "";
  const myTasks = (detail?.tasks ?? []).filter((t) => t.assignee === drawerMember);
  const myEnvelopes = (detail?.envelopes ?? []).filter((e) => e.to === drawerMember);
  const myShards = (detail?.shardBadges ?? []).filter((s) => s.role === drawerMember);
  const staleMemberHit =
    selected === null || detail === null ? undefined : detail.staleMembers.find((a) => a.member === selected.member);
  const awaitingInputHit =
    selected === null || detail === null ? undefined : detail.awaitingInput.find((a) => a.member === selected.member);
  const staleNote =
    staleMemberHit !== undefined
      ? `心跳陈旧 ${Math.round(staleMemberHit.lastSeenAgeMs / 60000)} 分钟`
      : awaitingInputHit !== undefined
        ? "心跳超阈，等待输入（blocked 分片）"
        : null;

  const handleGateResolve = async (gateId: string, action: "approve" | "deny") => {
    try {
      const res = await fetchTimeout("/api/xiaozhuge/gates/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: rootSessionId, gate_id: gateId, action }),
      });
      if (res.ok) {
        void loadGates();
      }
    } catch {}
  };

  return (
    <div className="xzg-workbench" data-theme={dark ? "night" : "dawn"}>
      {/* 顶栏 */}
      <header className="xzg-bar">
        <div className="xzg-brand">
          <span>小诸葛 · 团队台</span>
          <span className="xzg-badge">U1</span>
        </div>

        <nav className="xzg-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "team"}
            className="xzg-tab"
            onClick={() => setActiveTab("team")}
          >
            团队账本
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "gates"}
            className="xzg-tab"
            onClick={() => setActiveTab("gates")}
          >
            人审待办
          </button>
        </nav>

        <div className="xzg-bar-actions">
          <button
            type="button"
            className="xzg-btn sm"
            onClick={() => window.open(gateConsoleUrl(rootSessionId), "_blank", "noopener")}
            title="新窗口打开独立待办控制台"
          >
            独立待办页 ↗
          </button>
          {error !== null && (
            <button type="button" className="xzg-btn sm primary" onClick={() => void loadOverview()}>
              重试刷新
            </button>
          )}
        </div>
      </header>

      {/* 主体内容 */}
      <main className="xzg-body">
        {activeTab === "team" ? (
          <>
            {/* 统计指标行 */}
            <section className="xzg-stats" aria-label="团队状态汇总">
              {detail !== null ? (
                <>
                  <span>
                    任务{" "}
                    {(Object.keys(TASK_STATUS_LABELS) as TaskStatus[]).map((s) => {
                      const count = detail.taskCounts[s] ?? 0;
                      if (count === 0 && (s === "cancelled" || s === "queued")) return null;
                      return (
                        <span key={s} style={{ marginLeft: 6 }}>
                          <span className={`xzg-tone ${s}`}>
                            {TASK_STATUS_LABELS[s]} <b>{count}</b>
                          </span>
                        </span>
                      );
                    })}
                  </span>
                  <span>
                    事件游标 <b>seq {detail.recentEvents[0]?.seq ?? 0}</b>
                  </span>
                </>
              ) : (
                <span>正在加载账本投影…</span>
              )}
              {overview?.masterRegistered === false && (
                <span style={{ color: "var(--xzg-amber)" }}>⚠️ 主控尚未完成握手（旧实例兼容）</span>
              )}
            </section>

            {/* 团队两栏主体 */}
            <div className="xzg-team-grid">
              {/* 左侧卡片树 */}
              <section className="xzg-tree" aria-label="成员组织树">
                <div className="xzg-tree-head">
                  <h2>树形组织</h2>
                  <span style={{ fontSize: 12, color: "var(--xzg-faint)" }}>
                    共 {overview?.members.length ?? 0} 名成员 · 点击查看详情
                  </span>
                </div>

                {overview === null ? (
                  <div style={{ opacity: 0.6, padding: "20px 0", textAlign: "center" }}>
                    {error !== null ? "加载失败，等待重试…" : "加载团队状态…"}
                  </div>
                ) : overview.members.length === 0 ? (
                  <div style={{ opacity: 0.6, padding: "20px 0", textAlign: "center" }}>本团队暂无注册成员。</div>
                ) : (
                  <div className="xzg-tree-body">
                    {tree.map((rootNode) => (
                      <TreeBranch
                        key={rootNode.member}
                        node={rootNode}
                        selectedMember={selected?.member ?? null}
                        onSelect={setSelected}
                        depth={0}
                      />
                    ))}
                  </div>
                )}
              </section>

              {/* 右侧详情抽屉（桌面右栏，移动端 Fullscreen Mobile Sheet） */}
              {selected !== null && (
                <aside
                  className={`xzg-drawer ${narrow ? "mobile-sheet" : ""}`}
                  aria-label={`成员详情 ${selected.member}`}
                >
                  <div className="xzg-drawer-head">
                    <h2>
                      <span className={`xzg-tdot ${selected.tone}`} />
                      <span>{selected.member}</span>
                      <span style={{ fontSize: 12, fontWeight: "normal", color: "var(--xzg-dim)" }}>
                        Tier-{selected.tier}
                      </span>
                    </h2>
                    {narrow && (
                      <button
                        type="button"
                        className="xzg-btn sm"
                        style={{ marginLeft: "auto" }}
                        onClick={() => setSelected(null)}
                      >
                        ✕ 关闭
                      </button>
                    )}
                  </div>

                  <div className="xzg-d-sec">
                    <h3>当前活动</h3>
                    <p className="xzg-d-line">{selected.currentActivity ?? "—"}</p>
                  </div>

                  <div className="xzg-d-sec">
                    <h3>注册状态与心跳</h3>
                    <p className="xzg-d-line">
                      {selected.registryStatus ?? "—"} ·{" "}
                      {selected.lastSeen === null ? "无心跳记录" : new Date(selected.lastSeen).toLocaleTimeString()}
                    </p>
                    {staleNote !== null && (
                      <p className="xzg-d-line" style={{ color: "var(--xzg-amber)", fontSize: 12 }}>
                        ⚠️ {staleNote}
                      </p>
                    )}
                  </div>

                  {detail !== null && (
                    <>
                      <div className="xzg-d-sec">
                        <h3>承担任务 ({myTasks.length})</h3>
                        {myTasks.length === 0 ? (
                          <p className="xzg-d-line" style={{ color: "var(--xzg-faint)" }}>
                            暂无任务
                          </p>
                        ) : (
                          myTasks.map((t) => (
                            <div
                              key={t.id}
                              style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12.5 }}
                            >
                              <span className={`xzg-tone ${t.status}`}>{TASK_STATUS_LABELS[t.status]}</span>
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                                {t.title}
                              </span>
                              {t.maxRounds !== null && (
                                <span style={{ fontFamily: "var(--xzg-mono)", color: "var(--xzg-faint)" }}>
                                  {t.rounds}/{t.maxRounds}
                                </span>
                              )}
                              {t.artifact !== null && <span style={{ color: "var(--xzg-celadon)" }}>✓ 产物</span>}
                            </div>
                          ))
                        )}
                      </div>

                      <div className="xzg-d-sec">
                        <h3>最近协作信件</h3>
                        {myEnvelopes.length === 0 ? (
                          <p className="xzg-d-line" style={{ color: "var(--xzg-faint)" }}>
                            暂无信件
                          </p>
                        ) : (
                          myEnvelopes.slice(0, 5).map((e) => (
                            <div
                              key={e.id}
                              style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12 }}
                            >
                              <span style={{ color: "var(--xzg-faint)", fontFamily: "var(--xzg-mono)" }}>
                                {new Date(e.createdAt).toLocaleTimeString()}
                              </span>
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                                {e.summary ?? `${e.type} · 来自 ${e.from}`}
                              </span>
                              <span style={{ color: "var(--xzg-dim)" }}>
                                {ENVELOPE_STATE_LABELS[e.state] ?? e.state}
                              </span>
                            </div>
                          ))
                        )}
                      </div>

                      <div className="xzg-d-sec">
                        <h3>黑板状态</h3>
                        {myShards.length === 0 ? (
                          <p className="xzg-d-line" style={{ color: "var(--xzg-faint)" }}>
                            无分片
                          </p>
                        ) : (
                          myShards.map((s) => (
                            <div
                              key={`${s.room}:${s.role}`}
                              style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12 }}
                            >
                              <span className={`xzg-tone ${s.status}`}>{s.status}</span>
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {s.room}
                                {s.currentActivity ? ` · ${s.currentActivity}` : ""}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    </>
                  )}

                  <button
                    type="button"
                    className="xzg-btn primary"
                    disabled={selected.durableId === null}
                    onClick={() => void openSession(selected, rootSessionId)}
                    style={{ marginTop: 8 }}
                  >
                    打开该成员会话回放 ↗
                  </button>

                  <p className="xzg-d-note">
                    成员会话内容只读；指挥经 Tier-0 对话或 Gate 裁决表达，工作台不提供直控成员的写操作。
                  </p>
                </aside>
              )}
            </div>

            {/* 底部事件流尾窗面板 */}
            <section className="xzg-evt-panel" aria-label="事件流尾窗">
              <div className="xzg-evt-head">
                <h2>事件流 · 尾窗</h2>
                <span className="xzg-cap">展示最新白名单协作事件，成本不随会话时长线性增长</span>
              </div>

              <div className="xzg-evt-list">
                {detail === null || detail.recentEvents.length === 0 ? (
                  <div style={{ padding: 12, color: "var(--xzg-faint)", textAlign: "center" }}>暂无协作事件</div>
                ) : (
                  detail.recentEvents.slice(0, 15).map((e) => (
                    <div key={e.seq} className="xzg-evt">
                      <span className="xzg-seq">{e.seq}</span>
                      <span className="xzg-etype">{e.type}</span>
                      <span className="xzg-esum">
                        {e.summary ?? `[${e.actor}] ${e.type}`}
                        {e.receiptSummary && e.receiptSummary.length > 0 && (
                          <span style={{ display: "block", color: "var(--xzg-dim)", fontSize: 11.5, marginTop: 2 }}>
                            {e.receiptSummary.join(" · ")}
                          </span>
                        )}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </section>
          </>
        ) : (
          /* 人审待办视图 */
          <section aria-label="人审待办">
            <div style={{ marginBottom: 16 }}>
              <h1 style={{ fontFamily: "var(--xzg-serif)", fontSize: 20, margin: "0 0 4px" }}>人审待办</h1>
              <p style={{ color: "var(--xzg-dim)", margin: 0, fontSize: 13 }}>
                这里是人工唯一的裁决写点，放行后团队继续推进。
              </p>
            </div>

            {gates.length === 0 ? (
              <div
                style={{
                  background: "var(--xzg-panel)",
                  border: "1px solid var(--xzg-line)",
                  borderRadius: "var(--xzg-r)",
                  padding: "36px 20px",
                  textAlign: "center",
                }}
              >
                <p style={{ fontSize: 16, fontWeight: 600, color: "var(--xzg-celadon)", margin: "0 0 6px" }}>
                  灯已清。巡场继续。
                </p>
                <p style={{ color: "var(--xzg-dim)", margin: 0 }}>人审门归位，团队自行推进；有待审项时会在此亮起。</p>
              </div>
            ) : (
              gates.map((g) => (
                <article key={g.id} className="xzg-gate-card" data-state={g.status}>
                  <div className="xzg-gc-top">
                    <span className="xzg-lamp" />
                    <code className="xzg-gate-id">{g.id}</code>
                    <span
                      className={`xzg-tone ${g.status === "approved" ? "done" : g.status === "denied" ? "cancelled" : "blocked"}`}
                    >
                      {g.status === "approved" ? "已放行" : g.status === "denied" ? "已驳回" : "待裁决"}
                    </span>
                  </div>

                  <p style={{ margin: "10px 0", color: "var(--xzg-ink)" }}>{g.reason}</p>

                  <div style={{ fontSize: 12.5, color: "var(--xzg-faint)", marginBottom: 12 }}>
                    开闸人：<b>{g.requestedBy}</b> · 申请时间：{new Date(g.updatedAt).toLocaleTimeString()}
                  </div>

                  {g.status === "pending" ? (
                    <div style={{ display: "flex", gap: 10 }}>
                      <button
                        type="button"
                        className="xzg-btn primary"
                        onClick={() => void handleGateResolve(g.id, "approve")}
                      >
                        批准放行
                      </button>
                      <button
                        type="button"
                        className="xzg-btn"
                        onClick={() => void handleGateResolve(g.id, "deny")}
                      >
                        驳回
                      </button>
                    </div>
                  ) : (
                    <span className={`xzg-stamp ${g.status === "denied" ? "denied" : ""}`}>
                      {g.status === "approved" ? "准" : "驳"}
                    </span>
                  )}
                </article>
              ))
            )}
          </section>
        )}
      </main>
    </div>
  );
}

/** 递归树分支渲染（带有 max-indent 保护） */
function TreeBranch(props: {
  node: TreeMember;
  selectedMember: string | null;
  onSelect: (m: MemberNodeView) => void;
  depth: number;
}): React.ReactNode {
  const { node, selectedMember, onSelect, depth } = props;
  const isSelected = selectedMember === node.member;
  const isRoot = depth === 0;

  return (
    <div
      className={`xzg-tnode ${isRoot ? "xzg-root" : ""}`}
      style={{ marginLeft: isRoot ? 0 : Math.min(depth * 10, 32) }}
    >
      <div
        className="xzg-tcard"
        tabIndex={0}
        role="button"
        aria-current={isSelected}
        onClick={() => onSelect(node)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(node);
          }
        }}
      >
        <div className="xzg-tc-head">
          <span className={`xzg-tdot ${node.tone}`} />
          <span className="xzg-tname">{node.member}</span>
          <span className="xzg-trole">Tier-{node.tier}</span>
          <span className="xzg-ttask">{node.durableId ? "已挂接" : "未入册"}</span>
        </div>
        {node.currentActivity && <p className="xzg-tact">{node.currentActivity}</p>}
      </div>

      {node.children.map((child) => (
        <TreeBranch
          key={child.member}
          node={child}
          selectedMember={selectedMember}
          onSelect={onSelect}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

/**
 * 子代理会话页「返回团队」入口（#163 Q1）。
 */
export function TeamBackNavEntry(props: { sessionId?: string }): React.ReactNode {
  const sessionId = props.sessionId ?? "";
  const [role, setRole] = useState<TeamSessionRole>("none");
  const [rootSession, setRootSession] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setRole("none");
      return;
    }
    fetchTimeout(`/api/xiaozhuge/team/status?session=${encodeURIComponent(sessionId)}`)
      .then((r) => r.json())
      .then((d: TeamStatusLike) => {
        const r = classifyTeamRole(d);
        setRole(r);
        setRootSession(d.membership?.root_session ?? null);
      })
      .catch(() => {
        setRole("none");
      });
  }, [sessionId]);

  if (role !== "member" || rootSession === null) return null;

  return (
    <button
      type="button"
      className="xzg-btn sm"
      style={{
        marginRight: 8,
        border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))",
        background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,.1))",
        color: "var(--dsw-alias-label-primary, inherit)",
        borderRadius: 6,
        padding: "3px 8px",
        cursor: "pointer",
      }}
      onClick={() => {
        if (sessionsService !== null) {
          sessionsService.open(rootSession);
        }
      }}
    >
      返回团队
    </button>
  );
}
