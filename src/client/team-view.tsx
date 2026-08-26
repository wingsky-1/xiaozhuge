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
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import flowStyles from "@xyflow/react/dist/style.css";

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

/** 着色语义 → 图例文案与几何图标（色值经 toneColors 随主题解析）。 */
const TONE_LEGEND: Record<NodeTone, { icon: string; label: string; light: string; dark: string }> = {
  running: { icon: "▶", label: "运行中", light: "#1a7f37", dark: "#3fb950" },
  blocked: { icon: "⚠", label: "阻塞", light: "#9a6700", dark: "#d29922" },
  done: { icon: "✓", label: "已完成", light: "#0969da", dark: "#58a6ff" },
  idle: { icon: "■", label: "静默", light: "#57606a", dark: "#8b949e" },
  lost: { icon: "×", label: "失联", light: "#cf222e", dark: "#f85149" },
};

/** 轮询间隔（ms）：画布基础低频；抽屉展开高频。失败指数退避封顶。 */
const POLL_CANVAS_MS = 5000;
const POLL_DRAWER_MS = 2000;
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

/** SubagentAddress（@deepseek-ai/dsh-host-apiproxy/api 形状的本地消费面）。 */
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

/** 树 → dagre TB 布局后的 React Flow nodes/edges。 */
export function layoutTree(roots: readonly TreeMember[]): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 28, ranksep: 56 });
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
      data: { ...member, depth },
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
  const m = data as unknown as MemberNodeView & { depth: number };
  const { fg, bg } = toneColors(m.tone);
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
      {/* 边锚点：父→子连线必需（隐藏视觉，仅提供拓扑连接位） */}
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} isConnectable={false} />
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
      const r = await fetch(overviewUrl(sessionId));
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
  const drawerOpen = selected !== null;
  useEffect(() => {
    if (!drawerOpen) return;
    const timer = window.setInterval(() => void load(), POLL_DRAWER_MS);
    return () => window.clearInterval(timer);
  }, [drawerOpen, load]);

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
  const { nodes, edges } = useMemo(() => layoutTree(tree), [tree]);

  // 选中成员随轮询刷新（保持引用最新）。
  useEffect(() => {
    if (selected === null || overview === null) return;
    const fresh = overview.members.find((m) => m.member === selected.member);
    if (fresh !== undefined && fresh !== selected) setSelected(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview]);

  const memberEvents =
    overview?.rooms
      .find((r) => r.room === "root")
      ?.recentEvents.filter((e) => e.actor === selected?.member)
      .slice(-8)
      .reverse() ?? [];

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
              <div style={labelStyle}>最近凭据</div>
              {memberEvents.length === 0 ? (
                <div style={{ opacity: 0.55 }}>暂无事件记录</div>
              ) : (
                memberEvents.map((e) => (
                  <div key={e.seq} style={{ display: "flex", gap: 8, padding: "3px 0" }}>
                    <span style={{ opacity: 0.55, fontVariantNumeric: "tabular-nums" }}>
                      {new Date(e.ts).toLocaleTimeString()}
                    </span>
                    <span>{e.type}</span>
                  </div>
                ))
              )}
            </div>
            <button
              type="button"
              disabled={selected.durableId === null}
              onClick={() => void openSession(selected, sessionId)}
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
 * 「打开会话」跳宿主原生回放——走 ISessions 公开导航面，mode 三级获取链
 * （评审阻塞项修订；绝不硬编码猜测 mode）：
 *   ① subagentAddress(childId) 直接返还已发现地址（自带 mode）；
 *   ② miss → refreshSubagents(parent) 拉 catalog 后重取；
 *   ③ 仍无 → 降级 open(parent) 跳父会话（原生轨迹可见成员活动），不崩 UI。
 */
async function openSession(member: MemberNodeView, parentSessionId: string): Promise<void> {
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
    else sessions.open(parentSessionId);
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
