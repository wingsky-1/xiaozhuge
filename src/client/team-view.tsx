/**
 * 团队视图 tab（issue #68）：房间树监控画布 + 成员抽屉（L1/L2）。
 *
 * - 经 conversation.view 插槽注册（见 index.tsx 协调器），tab 激活才挂载
 *   （宿主 view ring only:<active id> 渲染机制保证）——5s/2s 轮询随之只在
 *   用户注视本视图时发生，切走即随组件卸载停表；
 * - 数据面：GET /api/xiaozhuge/team/overview 只读轮询；失败指数退避
 *   （5s 起 ×2 封顶 30s，成功复位）；断网降级 = 保留最后一次快照 + 重试提示；
 * - 画布：@xyflow/react 只读模式 + @dagrejs/dagre TB 分层布局（issue 已批准
 *   选型：未来多层 tier 树与移动端缩放平移手势受益）；
 * - 一切动态内容纯文本渲染：不解析 markdown、不自动展开链接、不做语言生成；
 * - 双主题：宿主 body[data-ds-dark-theme] 属性经 MutationObserver 映射到
 *   colorMode，着色语义双主题一致并辅几何图标（不依赖单一色觉通道）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Handle,
  Panel,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import flowStyles from "@xyflow/react/dist/style.css";
import { fetchTimeout } from "./fetch.js";

/* ---------------- 视图模型（与服务端投影面一致，纯文本渲染） ---------------- */

type NodeTone = "running" | "blocked" | "done" | "idle" | "lost";

interface MemberNodeView {
  member: string;
  tier: number;
  parent: string | null;
  durableId: string | null;
  registryStatus: string | null;
  tone: NodeTone;
  currentActivity: string | null;
  lastSeen: number | null;
}

interface RoomView {
  room: string;
  counts: Record<NodeTone, number>;
  recentEvents: Array<{ seq: number; ts: number; actor: string; type: string }>;
}

interface TeamOverview {
  isTeam: boolean;
  masterRegistered: boolean;
  members: MemberNodeView[];
  rooms: RoomView[];
}

/* ---------------- 团队详情投影镜像（issue #130；与 /api/xiaozhuge/team/detail 响应形状一致） ---------------- */

/** 客户端本地 TaskStatus 五值镜像（client 为浏览器 bundle 不 import runtime；
 * 与 runtime types.ts TASK_STATUSES 五值冻结同步——新增状态值须同步此处）。 */
type TaskStatus = "queued" | "running" | "blocked" | "done" | "cancelled";

/** 任务状态计数 chips 文案（cancelled 终态非告警：中性灰 opacity，不复用 lost 红）。 */
const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "排队",
  running: "进行中",
  blocked: "阻塞",
  done: "已完成",
  cancelled: "已取消",
};

/** 信箱信封三段状态文案（服务端只产出三态；未知键兜底显示原文，防脏值渲染成 undefined）。 */
const ENVELOPE_STATE_LABELS: Record<string, string> = {
  unread: "待读",
  claimed: "认领中",
  acked: "已确认",
};

/** 与服务端 detail 归约一致的客户端镜像（纯文本渲染，payload 不出投影面）。 */
interface TeamDetailView {
  isTeam: boolean;
  tasks: TaskLedgerView[];
  corruptTaskFiles: string[];
  taskCounts: Record<TaskStatus, number>;
  envelopes: MailboxHeadView[];
  shardBadges: ShardBadgeView[];
  masterIdle: boolean;
  staleMembers: StaleAnnotation[];
  awaitingInput: StaleAnnotation[];
  /** Q2（#162）：事件流白名单投影（摘要 + 凭据回执）。 */
  recentEvents: RecentEventView[];
}

/** Q2（#162）：事件投影单条（服务端 RecentEventView 的客户端镜像）。 */
interface RecentEventView {
  room: string;
  seq: number;
  ts: number;
  actor: string;
  type: string;
  summary: string | null;
  receiptSummary: string[] | null;
}

interface TaskLedgerView {
  id: string;
  title: string;
  room: string;
  status: string;
  assignee: string | null;
  rounds: number;
  maxRounds: number | null;
  touched: string[];
  rev: number;
  createdAt: number;
  updatedAt: number;
  artifact: string | null;
}

interface MailboxHeadView {
  id: string;
  to: string;
  from: string;
  type: string;
  state: string;
  createdAt: number;
  /** PR-B（#169）：task-assign 信封白名单摘要（task <id>：<title>），其余类型 null。 */
  summary: string | null;
}

interface ShardBadgeView {
  room: string;
  role: string;
  status: string;
  updatedAt: number;
  currentActivity: string | null;
}

interface StaleAnnotation {
  member: string;
  lastSeenAgeMs: number;
}

function detailUrl(sessionId: string): string {
  return `/api/xiaozhuge/team/detail?session=${encodeURIComponent(sessionId)}`;
}

/** 本地黑板保留态集合（client 不 import runtime；与 types.ts RESERVED_STAGES 三值冻结同步）。
 * 分片 status 读侧容忍脏值：保留态走徽标样式，脏值走中性 opacity 文本——
 * 直接 cast NodeTone 会令 TONE_LEGEND 越界抛错，故双分支处理。 */
const RESERVED_STAGE_SET = new Set(["running", "blocked", "done"]);

function shardStatusStyle(status: string): React.CSSProperties {
  return RESERVED_STAGE_SET.has(status)
    ? { ...badgeStyle(status as NodeTone), fontSize: 11 }
    : { opacity: 0.55, fontSize: 11, fontVariantNumeric: "tabular-nums" };
}

/** 着色语义 → 图例文案与几何图标（色值经 toneColors 随主题解析）。 */
const TONE_LEGEND: Record<NodeTone, { icon: string; label: string; light: string; dark: string }> = {
  running: { icon: "▶", label: "运行中", light: "#1a7f37", dark: "#3fb950" },
  blocked: { icon: "⚠", label: "阻塞", light: "#9a6700", dark: "#d29922" },
  done: { icon: "✓", label: "已完成", light: "#0969da", dark: "#58a6ff" },
  idle: { icon: "■", label: "静默", light: "#57606a", dark: "#8b949e" },
  lost: { icon: "×", label: "失联", light: "#cf222e", dark: "#f85149" },
};

/** 轮询间隔（ms）：画布基础低频；抽屉展开高频；detail 抽屉展开中频（指纹缓存命中 304 廉价）。失败指数退避封顶。 */
const POLL_CANVAS_MS = 5000;
const POLL_DRAWER_MS = 2000;
const POLL_DETAIL_MS = 5000;
const POLL_BACKOFF_CAP_MS = 30000;

/** 宿主暗色主题标记（dsh-web 前端在 body 上维护）。 */
function isDarkTheme(): boolean {
  return document.body.getAttribute("data-ds-dark-theme") !== null;
}

function toneColors(tone: NodeTone): { fg: string; bg: string } {
  const c = TONE_LEGEND[tone];
  const fg = isDarkTheme() ? c.dark : c.light;
  return { fg, bg: `${fg}1f` };
}

/** React Flow 样式一次性注入（css-as-text 进 bundle；宿主 loader 只 load JS）。
 * 幂等标记照 dsh-client-ui-conversation 官方 data-plugin-css 先例；不随组件
 * 卸载移除（官方同款取舍：常驻无害，卸载移除会在多实例场景闪断样式）。 */
function injectFlowStylesOnce(): void {
  if (document.querySelector('style[data-plugin-css="xiaozhuge/team-view-flow"]') !== null) return;
  const el = document.createElement("style");
  el.setAttribute("data-plugin-css", "xiaozhuge/team-view-flow");
  el.textContent = flowStyles;
  document.head.appendChild(el);
}

/** 当前是否移动端宽度（抽屉降级全屏 sheet）。 */
function isNarrowViewport(): boolean {
  return window.matchMedia("(max-width: 768px)").matches;
}

/* ---------------- sessions 服务面（公开契约 ISessions 的消费子集） ---------------- */

/** SubagentAddress（官方 @deepseek-ai/dsh-subagent/client 形状的本地消费面；0.1.2 起 dsh-host-apiproxy 已删，结构逐字段一致）。 */
interface SubagentAddressLike {
  parentSessionId: string;
  childSessionId: string;
  mode: "one-shot" | "continuable";
}

/** ISessions 导航子集（open/openSubagent/subagentAddress/refreshSubagents）。 */
interface SessionsNav {
  open(id: string): void;
  openSubagent(address: SubagentAddressLike): void;
  subagentAddress(id: string): SubagentAddressLike | undefined;
  refreshSubagents(parentSessionId: string): Promise<void>;
}

/* ---------------- 树组装 + dagre 布局（确定性：同输入同布局） ---------------- */

interface TreeMember extends MemberNodeView {
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
  // 排序保证同输入同输出（dagre 布局与 key 稳定）。
  const sortTree = (nodes: TreeMember[]) => {
    nodes.sort((a, b) => a.member.localeCompare(b.member));
    for (const n of nodes) sortTree(n.children);
  };
  sortTree(roots);
  return roots;
}

/** 树 → dagre 布局后的 React Flow nodes/edges（A4-7 响应式 rankdir：宽视口 LR / 窄视口 TB）。 */
export function layoutTree(
  roots: readonly TreeMember[],
  opts: { rankdir?: "TB" | "LR" } = {},
): { nodes: Node[]; edges: Edge[] } {
  const rankdir = opts.rankdir ?? "TB";
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  // dagre 语义：TB 下 nodesep=同级垂直间距、ranksep=层级水平间距；
  // LR 下 x=层级方向、y=同级分布——nodesep/ranksep 语义互换，数值沿用
  // 现状（测试锁定，A4-7 S1）。
  g.setGraph({ rankdir, nodesep: 28, ranksep: 56 });
  const NODE_W = 216;
  const NODE_H = 76;
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const walk = (member: TreeMember, depth: number): void => {
    g.setNode(member.member, { width: NODE_W, height: NODE_H });
    nodes.push({
      id: member.member,
      type: "team",
      position: { x: 0, y: 0 },
      data: { ...member, depth, rankdir },
      draggable: false,
      selectable: true,
    });
    for (const child of member.children) {
      g.setEdge(member.member, child.member);
      edges.push({ id: `e-${member.member}-${child.member}`, source: member.member, target: child.member });
      walk(child, depth + 1);
    }
  };
  for (const root of roots) walk(root, 0);
  dagre.layout(g);

  for (const node of nodes) {
    const pos = g.node(node.id);
    node.position = { x: (pos?.x ?? 0) - NODE_W / 2, y: (pos?.y ?? 0) - NODE_H / 2 };
  }
  return { nodes, edges };
}

/* ---------------- 自定义节点（L1：角色名 + 状态徽标 + current_activity） ---------------- */

function MemberNodeCard({ data }: NodeProps): React.ReactNode {
  const m = data as unknown as MemberNodeView & { depth: number; rankdir: "TB" | "LR" };
  const { fg, bg } = toneColors(m.tone);
  // A4-7：LR 布局主轴水平——边锚点左入右出；TB 维持上入下出（H5）。
  const targetPos = m.rankdir === "LR" ? Position.Left : Position.Top;
  const sourcePos = m.rankdir === "LR" ? Position.Right : Position.Bottom;
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        border: `1px solid ${fg}`,
        borderLeftWidth: 4,
        borderRadius: 10,
        background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,.08))",
        color: "var(--dsw-alias-label-primary, inherit)",
        padding: "8px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        overflow: "hidden",
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 13 }}>
        <span
          aria-label={TONE_LEGEND[m.tone].label}
          title={TONE_LEGEND[m.tone].label}
          style={{
            color: fg,
            background: bg,
            borderRadius: 999,
            padding: "0 7px",
            lineHeight: "18px",
            fontSize: 11,
            whiteSpace: "nowrap",
          }}
        >
          {TONE_LEGEND[m.tone].icon} {TONE_LEGEND[m.tone].label}
        </span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.member}</span>
      </div>
      <div style={{ opacity: 0.75, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {m.currentActivity ?? "—"}
      </div>
      {/* 边锚点：父→子连线必需（隐藏视觉，仅提供拓扑连接位；方向随 rankdir） */}
      <Handle type="target" position={targetPos} style={{ opacity: 0 }} isConnectable={false} />
      <Handle type="source" position={sourcePos} style={{ opacity: 0 }} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { team: MemberNodeCard };

/* ---------------- 主组件：轮询 + 画布 + 抽屉 ---------------- */

function overviewUrl(sessionId: string): string {
  return `/api/xiaozhuge/team/overview?session=${encodeURIComponent(sessionId)}`;
}

export function TeamView(props: { sessionId?: string }): React.ReactNode {
  const sessionId = props.sessionId ?? "";
  const [overview, setOverview] = useState<TeamOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MemberNodeView | null>(null);
  const [narrow, setNarrow] = useState(isNarrowViewport());
  const [dark, setDark] = useState(isDarkTheme());
  const backoffRef = useRef(POLL_CANVAS_MS);
  const [detail, setDetail] = useState<TeamDetailView | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailBackoffRef = useRef(POLL_DETAIL_MS);

  injectFlowStylesOnce();

  // 移动端断点跟随。
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // 宿主暗色主题跟随：body 属性变化 → 重渲着色（MutationObserver）。
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(isDarkTheme()));
    observer.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
    return () => observer.disconnect();
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (sessionId.length === 0) return;
    try {
      const r = await fetchTimeout(overviewUrl(sessionId));
      if (!r.ok && r.status !== 304) throw new Error(`HTTP ${r.status}`);
      if (r.ok) {
        const d = (await r.json()) as TeamOverview;
        setOverview(d);
      }
      setError(null);
      backoffRef.current = POLL_CANVAS_MS;
    } catch (e) {
      // 断网降级：保留最后一次快照（不清空 overview），仅提示重试。
      setError((e as Error).message ?? "network error");
      backoffRef.current = Math.min(backoffRef.current * 2, POLL_BACKOFF_CAP_MS);
    }
  }, [sessionId]);

  // detail 拉取（与 load 同构）：成功复位退避并刷新快照；失败只置独立错误位、
  // 不清最后 detail 快照；退避走 detailBackoffRef（不与 overview 共用，单点失败互不拖累）。
  const loadDetail = useCallback(async (): Promise<void> => {
    if (sessionId.length === 0) return;
    try {
      const r = await fetchTimeout(detailUrl(sessionId));
      if (!r.ok && r.status !== 304) throw new Error(`HTTP ${r.status}`);
      if (r.ok) {
        const d = (await r.json()) as TeamDetailView;
        setDetail(d);
      }
      setDetailError(null);
      detailBackoffRef.current = POLL_DETAIL_MS;
    } catch (e) {
      // 断网降级：保留最后一次 detail 快照（不清空），仅提示重试。
      setDetailError((e as Error).message ?? "network error");
      detailBackoffRef.current = Math.min(detailBackoffRef.current * 2, POLL_BACKOFF_CAP_MS);
    }
  }, [sessionId]);

  // 首载 + 画布低频轮询（失败指数退避：以退避间隔自重排定时器）。
  useEffect(() => {
    if (sessionId.length === 0) return;
    let timer = 0;
    let disposed = false;
    const tick = (): void => {
      void load().then(() => {
        if (!disposed) timer = window.setTimeout(tick, backoffRef.current);
      });
    };
    tick();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [load, sessionId]);

  // 抽屉展开高频轮询（独立短周期；退避仅作用于基础轮询）。
  // ADR 0021：与基础/detail 轮询同款串行自重排——setInterval 在上一次 load
  // 挂起（半开连接/服务端慢）时按固定周期叠加请求，占满浏览器同源连接池致
  // 全部请求 pending；改为上一次 settle 后再排下一次，杜绝请求堆积。
  const drawerOpen = selected !== null;
  useEffect(() => {
    if (!drawerOpen) return;
    let timer = 0;
    let disposed = false;
    const tick = (): void => {
      void load().then(() => {
        if (!disposed) timer = window.setTimeout(tick, POLL_DRAWER_MS);
      });
    };
    tick();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [drawerOpen, load]);

  // detail 独立轮询：仅抽屉展开时运行，以 detailBackoffRef 自重排实现独立指数退避
  // （失败拉长重试间隔封顶 30s，成功复位 5s；不占用 overview 的 backoffRef）。
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

  // 抽屉状态同步 URL query（issue 正文目标 ?room=&actor=）：replaceState 不新增
  // 历史项；卸载时清理，避免把团队视图的 query 泄漏进宿主会话 URL。
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
  useEffect(
    () => () => {
      // 卸载清理：移除本视图写入的 query 残留。
      const url = new URL(window.location.href);
      if (url.searchParams.has("actor") || url.searchParams.has("room")) {
        url.searchParams.delete("actor");
        url.searchParams.delete("room");
        window.history.replaceState(null, "", url.toString());
      }
    },
    [],
  );

  // 初始 URL ?actor= 恢复抽屉（数据首次到位时执行一次）。
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

  const tree = useMemo(() => buildTree(overview?.members ?? []), [overview]);
  // #163 P1-1：跨成员跳转的 catalog parent 恒用团队根 id（tier0 durableId），
  // 子代理页挂团队 tab 时 sessionId 是 child id，直接复用会 refresh/open 错位。
  const rootSessionId = useMemo(() => rootSessionOf(overview, sessionId), [overview, sessionId]);
  // A4-7 响应式树布局：宽视口 LR（根左叶右，宽屏利用率高）；窄视口 TB
  // （纵向滚动友好，移动端不需横向平移）——复用 narrow 响应式判定。
  const { nodes, edges } = useMemo(
    () => layoutTree(tree, { rankdir: narrow ? "TB" : "LR" }),
    [tree, narrow],
  );

  // 选中成员随轮询刷新（保持引用最新）。
  useEffect(() => {
    if (selected === null || overview === null) return;
    const fresh = overview.members.find((m) => m.member === selected.member);
    if (fresh !== undefined && fresh !== selected) setSelected(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview]);

  // 抽屉四区块派生（渲染内 filter，数据量 <= 数十条无需 memo）。
  const drawerMember = selected?.member ?? "";

  // 成员「最近协作事件」：详情快照优先（Q2，#162：detail.recentEvents 白名单投影，
  // 含摘要/凭据回执）；detail 未达（首开抽屉空窗）时降级 overview.recentEvents，
  // 避免误显示「暂无事件记录」（评审 P1-8）。两源统一归一化为同构形态
  // （overview 四键降级源无 summary/receiptSummary → 置 null，渲染与 detail 同构）。
  interface MemberEventRow {
    seq: number;
    ts: number;
    type: string;
    summary: string | null;
    receiptSummary: string[] | null;
  }
  const normalizeEvent = (e: RecentEventView | { seq: number; ts: number; type: string }): MemberEventRow => ({
    seq: e.seq,
    ts: e.ts,
    type: e.type,
    summary: "summary" in e ? e.summary : null,
    receiptSummary: "receiptSummary" in e ? (e.receiptSummary ?? null) : null,
  });
  const memberEvents: MemberEventRow[] =
    detail !== null
      ? (detail.recentEvents ?? []).filter((e) => e.actor === drawerMember).slice(-8).map(normalizeEvent).reverse()
      : overview?.rooms
          .find((r) => r.room === "root")
          ?.recentEvents.filter((e) => e.actor === drawerMember)
          .slice(-8)
          .map(normalizeEvent)
          .reverse() ?? [];

  const myTasks = (detail?.tasks ?? []).filter((t) => t.assignee === drawerMember);
  // 服务端已按每成员每 state 各 5 条截断，客户端不做二次 slice。
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

  if (sessionId.length === 0) return null;

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
      {/* 顶部汇总条（图例 + 计数，口径 = 成员表着色） */}
      <div
        style={{
          display: "flex",
          gap: 14,
          alignItems: "center",
          padding: "8px 16px",
          borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))",
          fontSize: 12,
          flex: "none",
          flexWrap: "wrap",
        }}
      >
        {(Object.keys(TONE_LEGEND) as NodeTone[]).map((tone) => {
          const count = overview?.members.filter((m) => m.tone === tone).length ?? 0;
          const { fg } = toneColors(tone);
          return (
            <span key={tone} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ color: fg }}>{TONE_LEGEND[tone].icon}</span>
              {TONE_LEGEND[tone].label}
              <strong>{count}</strong>
            </span>
          );
        })}
        {/* 任务账本计数 chips（#130）：taskCounts 五键恒全量（空账本全 0）；cancelled 中性灰非告警 */}
        {detail !== null ? (
          <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
            {(Object.keys(TASK_STATUS_LABELS) as TaskStatus[]).map((s) => (
              <span key={s} style={{ opacity: s === "cancelled" ? 0.55 : 1 }}>
                {TASK_STATUS_LABELS[s]}
                <strong style={{ marginLeft: 3 }}>{detail.taskCounts[s]}</strong>
              </span>
            ))}
            {detail.masterIdle ? <span style={{ color: "#9a6700" }}>主控心跳超阈</span> : null}
          </span>
        ) : null}
        {error !== null ? (
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8, alignItems: "center" }}>
            <span style={{ color: "#cf222e" }}>刷新失败（展示最后快照）</span>
            <button type="button" onClick={() => void load()} style={retryButtonStyle}>
              重试
            </button>
          </span>
        ) : null}
      </div>

      {/* L3 未握手黄条（#79）：静态框架文案，不渲染任何服务端动态内容（防注入） */}
      {overview !== null && overview.isTeam && !overview.masterRegistered ? (
        <div
          role="status"
          style={{
            margin: "8px 12px 0",
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #d29922",
            background: "rgba(210, 153, 34, 0.12)",
            fontSize: 13,
          }}
        >
          主控尚未完成启动握手：实例已初始化，但 tier0 主控未在注册表中（旧实例兼容态）。
          可在会话中重发「从对账节继续」恢复巡场。
        </div>
      ) : null}

      {/* L1 房间树画布（只读：禁止拖拽/连线，允许平移缩放） */}
      <div style={{ flex: 1, minHeight: 0 }}>
        {overview === null ? (
          <div style={{ opacity: 0.6, padding: 24, textAlign: "center" }}>
            {error !== null ? "加载失败，等待重试…" : "加载团队状态…"}
          </div>
        ) : overview.members.length === 0 ? (
          <div style={{ opacity: 0.6, padding: 24, textAlign: "center" }}>本会话暂无注册成员。</div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            colorMode={dark ? "dark" : "light"}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={true}
            edgesFocusable={false}
            onNodeClick={(_event, node) => {
              const found = overview.members.find((m) => m.member === node.id);
              setSelected(found ?? null);
            }}
            onPaneClick={() => setSelected(null)}
          >
            <Background />
            {/* A4-3 自动布局明示：只读画布提示（半透明底防暗色不可读，S2） */}
            <Panel
              position="top-right"
              style={{
                background: "rgba(127,127,127,.12)",
                borderRadius: 6,
                padding: "4px 8px",
                fontSize: 11,
                color: "var(--dsw-alias-label-secondary, rgba(127,127,127,.75))",
                pointerEvents: "none",
              }}
            >
              自动布局 · 只读画布（可平移缩放）
            </Panel>
          </ReactFlow>
        )}
      </div>

      {/* L2 抽屉：桌面右侧滑出，窄视口全屏 sheet */}
      {selected !== null ? (
        <div
          role="dialog"
          aria-label={`成员详情 ${selected.member}`}
          onKeyDown={(e) => {
            if (e.key === "Escape") setSelected(null);
          }}
          style={{
            position: "fixed",
            zIndex: 60,
            ...(narrow ? { inset: 0 } : { top: 0, right: 0, bottom: 0, width: 360 }),
            background: "var(--dsw-specific-input-major, #fff)",
            color: "var(--dsw-alias-label-primary, #1a1a1a)",
            borderLeft: narrow ? "none" : "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))",
            boxShadow: "-8px 0 32px rgba(0,0,0,.18)",
            display: "flex",
            flexDirection: "column",
            fontSize: 13,
          }}
        >
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))",
              display: "flex",
              alignItems: "center",
              gap: 8,
              flex: "none",
            }}
          >
            <strong>{selected.member}</strong>
            <span style={{ opacity: 0.6 }}>Tier-{selected.tier}</span>
            <span style={{ ...badgeStyle(selected.tone), marginLeft: "auto" }}>
              {TONE_LEGEND[selected.tone].icon} {TONE_LEGEND[selected.tone].label}
            </span>
            <button type="button" aria-label="关闭抽屉" onClick={() => setSelected(null)} style={closeButtonStyle}>
              ×
            </button>
          </div>
          <div style={{ padding: "12px 16px", overflow: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
            <Row label="当前活动">{selected.currentActivity ?? "—"}</Row>
            <Row label="注册状态">{selected.registryStatus ?? "—"}</Row>
            <Row label="最近心跳">
              {selected.lastSeen === null ? "—" : new Date(selected.lastSeen).toLocaleString()}
            </Row>
            <div>
              <div style={labelStyle}>最近协作事件</div>
              {memberEvents.length === 0 ? (
                <div style={{ opacity: 0.55 }}>暂无事件记录</div>
              ) : (
                memberEvents.map((e) => (
                  <div key={e.seq} style={{ padding: "3px 0" }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                      <span style={{ opacity: 0.55, fontVariantNumeric: "tabular-nums" }}>
                        {new Date(e.ts).toLocaleTimeString()}
                      </span>
                      {/* Q2（#162）：summary 白名单摘要（能拼则展示，否则类型名兜底） */}
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                        {e.summary !== null ? e.summary : e.type}
                      </span>
                    </div>
                    {/* 凭据回执（#98 步骤 3）：handoff 事件展开逐条 pass:/fail: 结论 */}
                    {e.receiptSummary !== null && e.receiptSummary.length > 0 ? (
                      <div style={{ marginTop: 2, paddingLeft: 70, display: "flex", flexDirection: "column", gap: 1 }}>
                        {e.receiptSummary.map((line, i) => (
                          <span key={i} style={{ opacity: 0.8, fontSize: 12, wordBreak: "break-word" }}>
                            {line}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
            {/* #130 协作数据四区块：detail 快照优先展示；服务端不可达时降级提示并保留重试入口 */}
            {detail !== null ? (
              <>
                <div>
                  <div style={labelStyle}>承担任务</div>
                  {myTasks.length === 0 ? (
                    <div style={{ opacity: 0.55 }}>暂无任务</div>
                  ) : (
                    myTasks.map((t) => (
                      <div key={t.id} style={{ display: "flex", gap: 8, padding: "3px 0", alignItems: "baseline" }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{t.title}</span>
                        <span style={{ opacity: 0.55, fontVariantNumeric: "tabular-nums" }}>
                          {t.status}
                          {t.maxRounds !== null ? ` ${t.rounds}/${t.maxRounds}` : ""}
                          {t.artifact !== null ? " · 产物✓" : ""}
                        </span>
                      </div>
                    ))
                  )}
                </div>
                <div>
                  <div style={labelStyle}>最近协作信件</div>
                  {myEnvelopes.length === 0 ? (
                    <div style={{ opacity: 0.55 }}>暂无信件</div>
                  ) : (
                    myEnvelopes.map((e) => (
                      <div key={e.id} style={{ display: "flex", gap: 8, padding: "3px 0" }}>
                        <span style={{ opacity: 0.55, fontVariantNumeric: "tabular-nums" }}>
                          {new Date(e.createdAt).toLocaleTimeString()}
                        </span>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                          {/* PR-B（#169）：白名单摘要优先（task-assign → task <id>：<title>），
                              其余类型/非法 body 退化「类型 · 来自」兜底。 */}
                          {e.summary !== null ? e.summary : `${e.type} · 来自 ${e.from}`}
                        </span>
                        <span style={{ opacity: 0.55 }}>{ENVELOPE_STATE_LABELS[e.state] ?? e.state}</span>
                      </div>
                    ))
                  )}
                </div>
                <div>
                  <div style={labelStyle}>黑板状态</div>
                  {myShards.length === 0 ? (
                    <div style={{ opacity: 0.55 }}>无分片</div>
                  ) : (
                    myShards.map((s) => (
                      <div key={`${s.room}:${s.role}`} style={{ display: "flex", gap: 8, padding: "3px 0" }}>
                        <span style={shardStatusStyle(s.status)}>{s.status}</span>
                        <span style={{ opacity: 0.75, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {s.room}
                          {s.currentActivity !== null ? ` · ${s.currentActivity}` : ""}
                        </span>
                      </div>
                    ))
                  )}
                </div>
                <div>
                  <div style={labelStyle}>运行态标注</div>
                  {staleNote === null ? <div style={{ opacity: 0.55 }}>心跳正常</div> : <div>{staleNote}</div>}
                </div>
              </>
            ) : detailError !== null ? (
              <div style={{ opacity: 0.6, display: "flex", gap: 8, alignItems: "center" }}>
                协作数据暂不可用（展示最后快照）
                <button type="button" onClick={() => void loadDetail()} style={retryButtonStyle}>
                  重试
                </button>
              </div>
            ) : null}
            <button
              type="button"
              disabled={selected.durableId === null}
              onClick={() => void openSession(selected, rootSessionId)}
              style={{
                marginTop: 4,
                padding: "8px 0",
                border: "none",
                borderRadius: 8,
                background: "var(--dsw-static-deepseek-500, #2da44e)",
                color: "#fff",
                cursor: selected.durableId === null ? "not-allowed" : "pointer",
                opacity: selected.durableId === null ? 0.5 : 1,
              }}
            >
              打开该成员的会话回放
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 抽屉键值行。 */
function Row(props: { label: string; children: React.ReactNode }): React.ReactNode {
  return (
    <div>
      <div style={labelStyle}>{props.label}</div>
      <div>{props.children}</div>
    </div>
  );
}

/**
 * 从总览推导「团队根会话 id」（#163 P1-1：openSession 三级链的 parent 必须是
 * 团队根，而非当前（可能为子代理的）会话 id）。来源 = overview 中 tier0 成员的
 * durableId（#79 注释明示 tier0 主控 = 宿主主会话 id）；master 未登记（旧实例
 * 兼容态）时回落当前会话 id。零额外请求，复用已加载的 overview。
 */
export function rootSessionOf(overview: TeamOverview | null, fallbackSessionId: string): string {
  if (overview === null) return fallbackSessionId;
  const tier0 = overview.members.find((m) => m.tier === 0);
  return tier0?.durableId ?? fallbackSessionId;
}

/**
 * 「打开会话」跳宿主原生回放——走 ISessions 公开导航面，mode 三级获取链
 * （评审阻塞项修订；绝不硬编码猜测 mode）：
 *   ① subagentAddress(childId) 直接返还已发现地址（自带 mode）；
 *   ② miss → refreshSubagents(parent) 拉 catalog 后重取；
 *   ③ 仍无 → 降级 open(childId)——宿主 select() 内部 navigationAddress 会从
 *     已刷新 catalog 反查子会话地址，**未打开过的子会话也能跳转**
 *     （issue #169 根因修正：原降级 open(parent) 在团队页等于原地跳转）。
 * @param parentSessionId 团队根会话 id（#163 P1-1：refresh 的 catalog parent）。
 */
export async function openSession(member: MemberNodeView, parentSessionId: string): Promise<void> {
  const sessions = sessionsService;
  const childId = member.durableId;
  if (sessions === null || childId === null) return;
  let address = safeAddress(sessions, childId);
  if (address === undefined) {
    try {
      await sessions.refreshSubagents(parentSessionId);
    } catch {
      // catalog 不可用：走降级。
    }
    address = safeAddress(sessions, childId);
  }
  try {
    if (address !== undefined) sessions.openSubagent(address);
    else sessions.open(childId);
  } catch {
    // fail-loud 面：兜底不白屏，保留当前视图。
  }
}

function safeAddress(sessions: SessionsNav, childId: string): SubagentAddressLike | undefined {
  try {
    return sessions.subagentAddress(childId);
  } catch {
    return undefined;
  }
}

/* ---------------- 模块级服务句柄（index.tsx apply 时注入，同 apiClient 先例） ---------------- */

let sessionsService: SessionsNav | null = null;

export function bindSessionsService(svc: SessionsNav | null): void {
  sessionsService = svc;
}

/* ---------------- #163 子代理页「返回团队」入口（conversation.session.header.actions 官方插槽） ---------------- */

/**
 * 当前会话在团队中的身份三态（#163：header 导航入口的显隐依据）。
 * - root：is_team=true 且非成员（主控会话自身）——团队 tab 已在 tab 栏，无需返回按钮；
 * - member：is_team=true 且经反查命中某实例（子代理会话）——显示「返回团队」；
 * - none：非团队会话——隐藏。
 * 纯函数便于单测（评审 P1-4：三态判定抽离）。
 */
export type TeamSessionRole = "root" | "member" | "none";

export function classifyTeamRole(d: TeamStatusLike): TeamSessionRole {
  if (d.is_team !== true) return "none";
  if (d.membership !== null && d.membership !== undefined && d.membership.root_session.length > 0) {
    return "member";
  }
  return "root";
}

/** team/status 响应本地消费面（client 不 import plugin；与服务端响应形状一致）。 */
export interface TeamStatusLike {
  is_team: boolean;
  membership?: { root_session: string; member: string } | null;
}

/**
 * 子代理会话页「返回团队」入口（#163，O1 裁决）：官方 `conversation.session.header.actions`
 * 插槽（list/session/additive）按钮——回到所属团队主会话（sessions.open(root_session)，
 * O2 裁决：原生会话跳转，否决自造 URL 路由）。仅 member 会话显示；root/none 隐藏
 * （团队 tab 已在 tab 栏，避免重复入口）。
 *
 * 跨成员跳转（验收 2）：经团队 tab 达成——TeamViewWatcher 对子代理页反查 is_team=true
 * 已注册团队 tab（ConversationRoot 全会话统一渲染 input.right/header.actions 实证），
 * 团队 tab 内点成员节点走 openSession(selected, rootSessionId)（parent 已修正为根 id）。
 * 因此本按钮最小半径 = 返回根会话，不再自绘成员切换器（评审 P1-2：防过度设计）。
 */
export function TeamBackNavEntry(props: { sessionId?: string }): React.ReactNode {
  const sessionId = props.sessionId ?? "";
  const [role, setRole] = useState<TeamSessionRole>("none");
  const [rootSession, setRootSession] = useState<string | null>(null);

  // 随会话探测身份三态（仅 member 显示按钮）；fetch 失败静默降级为隐藏（不白屏）。
  useEffect(() => {
    let cancelled = false;
    if (!sessionId) {
      setRole("none");
      return;
    }
    fetchTimeout(`/api/xiaozhuge/team/status?session=${encodeURIComponent(sessionId)}`)
      .then((r) => r.json())
      .then((d: TeamStatusLike) => {
        if (cancelled) return;
        setRole(classifyTeamRole(d));
        setRootSession(d.membership?.root_session ?? null);
      })
      .catch(() => {
        if (!cancelled) setRole("none");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (role !== "member" || rootSession === null) return null;

  const goBack = (): void => {
    const sessions = sessionsService;
    if (sessions === null) return;
    try {
      sessions.open(rootSession);
    } catch {
      // fail-loud 面：导航失败不白屏，保留当前视图。
    }
  };

  return (
    <button
      type="button"
      id="xzg-team-back"
      title="返回所属团队"
      onClick={goBack}
      style={{
        whiteSpace: "nowrap",
        fontSize: 12,
        lineHeight: 1,
        padding: "6px 10px",
        borderRadius: 14,
        border: "1px solid var(--dsw-static-deepseek-500, rgba(45,164,78,.5))",
        background: "rgba(45,164,78,.12)",
        color: "var(--dsw-static-deepseek-500, #2da44e)",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        flex: "none",
        // 触控目标下限（WCAG 2.5.8 最小 24×24）。
        minWidth: 24,
        minHeight: 24,
      }}
    >
      返回团队
    </button>
  );
}

/* ---------------- 内联小样式 ---------------- */

const labelStyle: React.CSSProperties = { opacity: 0.6, marginBottom: 4 };
const retryButtonStyle: React.CSSProperties = {
  padding: "2px 10px",
  borderRadius: 6,
  border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
  background: "none",
  color: "inherit",
  cursor: "pointer",
};
const closeButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  fontSize: 18,
  lineHeight: 1,
  cursor: "pointer",
  color: "var(--dsw-alias-label-tertiary, #6b7280)",
  padding: "2px 6px",
  // 触控目标下限（WCAG 2.5.8 最小 24×24）。
  minWidth: 24,
  minHeight: 24,
};

function badgeStyle(tone: NodeTone): React.CSSProperties {
  const { fg, bg } = toneColors(tone);
  return { color: fg, background: bg, borderRadius: 999, padding: "1px 8px", fontSize: 11 };
}
