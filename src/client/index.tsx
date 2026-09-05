/**
 * 小诸葛浏览器端插件：输入框内「创建团队」按钮（官方 slots 方案，ADR 0014 修订）。
 *
 * 经 `conversation.input.right` 插槽渲染在输入框工具行右端、发送按钮旁边——
 * 宿主官方扩展点，非 DOM 注入（宿主升级不失效，主题/样式自动适配）。
 *
 * 交互：
 * - 仅首轮对话展示（会话快照 blank = 无用户消息且未建团）；
 * - 点击弹「选团段（场景）」浮层（复用 /api/xiaozhuge/team/scenarios 枚举）；
 * - 选定后本会话一键建团：team/create（服务端 init 持久化）→ session.prompt
 *   投递 tier0_prompt；工作区随会话推导（session.list cwd），输入框草稿作首条
 *   用户任务（空则只投递规程）。
 *
 * 0.1.2-rc.1 适配（issue #179 D-1）：conversation.input.right/header.actions 等
 * 插槽的 owner(InputZone) 数据面被移除（rc.1 renderSlot 传空 props）——组件不再
 * 从插槽 owner 读 session/input，改为官方 register spec 的 `inject: (sessionId) => props`
 * 通道（宿主注入当前会话 id，官方 input.dock/trajectory 同款形态）取 sessionId，
 * blank 经 sessions.list 快照订阅（useSyncExternalStore），draft 经
 * conversation.input.for(scope).state 门面读取。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
// 0.1.2 起 dsh-client-runtime 已删：类型面迁移到官方 dsh-api-session-controller /
// dsh-client-ui-conversation，且只走 type-only import（无 createScope 运行时值导入——
// kScope Symbol 单例：esbuild 内联会产生第二份 Symbol → scopeOf 读不到 tag；
// 会话作用域一律经 ctx.sessions.scope 服务方法边界寻址，见 clearSessionDraft）。
import type { SessionSnapshot, ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import type { IConversation } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { Context } from "@deepseek-ai/cordis";
import { TeamView, TeamBackNavEntry, bindSessionsService } from "./team-view.js";
import { fetchTimeout } from "./fetch.js";

/** 供类型消费方引用官方 InputZone 形状（本插件组件已不依赖插槽 owner 数据面）。 */
export type { InputZone } from "@deepseek-ai/dsh-client-ui-conversation/client";

/** apply 时注入的宿主 sessions 服务（ISessions：scope/scopeOf/list 等官方服务方法面）。 */
let sessionsService: ISessions | null = null;

/** apply 时注入的宿主 conversation 服务（官方公开面：per-session input 门面注册表）。 */
let conversationService: IConversation | null = null;

/**
 * 清空目标会话输入框草稿（issue 81）：经官方 conversation.input 注册表解析
 * 该会话的 SessionInput 门面，走唯一公开写路径 setDraft("")。
 * 作用域寻址：0.1.2 起不走 createScope 值导入（Symbol 单例问题），改走
 * ctx.sessions.scope(sessionId) 服务方法边界（ISessions.scope 返回 AgentContext，
 * conversation.input.for 经 scopeOf 读 tag 定位常驻门面），用完即弃。
 * 解析失败（scope 未就绪）只放弃清空，不影响已成功的建团流程。
 */
export function clearSessionDraft(sessionId: string): void {
  const sessions = sessionsService;
  const conversation = conversationService;
  if (!sessions || !conversation) return;
  const scopeCtx = sessions.scope(sessionId as Parameters<ISessions["scope"]>[0]);
  if (!scopeCtx) return;
  conversation.input.for(scopeCtx).setDraft("");
}

/** 团队状态探测（服务端只读 GET）。 */
interface TeamStatus {
  is_team: boolean;
  name?: string | null;
  playbook_digest?: string | null;
}

/** 场景枚举项（/api/xiaozhuge/team/scenarios）。 */
interface ScenarioEntry {
  name: string;
  source: "builtin" | "user" | "project";
}

/**
 * 启动消息头：与独立入口页 /xiaozhuge/launch 的 BOOT_MESSAGE_HEAD 保持一致
 * （client bundle 与服务端隔离，无法 import 共享——改动须两侧同步，
 * tests/plugin/team-launch.test.ts 的契约断言兜底）。
 */
export const BOOT_MESSAGE_HEAD =
  "团队已由人经入口创建，实例初始化完成。以下是你的 Tier-0 规程与场景编排" +
  "提示词全文（规程在前、场景段在后，以固定分隔符分界），请从启动对账节开始执行。首 turn 检查单：① 第一个工具调用必须是 team_reconcile（readiness gate，失败即上行摘要）；② 确认 goal 已创建；③ 输出首轮摘要上行。";

/** 本插件注册名（cordis 名册 id = npm 包名，经 dsh.client 契约）。 */
export const name = "@wingsky-1/dsh-xiaozhuge";

/** 需要的浏览器端服务：slots（插槽注册）+ sessions（官方服务方法面）+ conversation（草稿写路径）。 */
export const inject = ["slots", "sessions", "conversation"];

/** 浮层内固定文案。 */
const COPY = {
  button: "创建团队",
  dialogTitle: "选择团队场景",
  loading: "加载场景列表…",
  empty: "暂无可用场景",
  loadFailed: "加载失败",
  go: "在本会话创建团队并发送",
  creating: "创建中…",
  createFailed: "创建失败",
  projectBadge: "当前工作区",
  pickHint: "请先选择一个团队场景",
};

/** 场景条目的稳定 key（radio value 与选中判定共用，唯一事实源在 selected state）。 */
export function scenarioKey(s: { source: string; name: string }): string {
  return `${s.source}:${s.name}`;
}

/** 场景浮层（React 组件，固定在视口居中；导出供 client 行为测试驱动）。 */
export function ScenarioPicker(props: {
  scenarios: ScenarioEntry[];
  busy: boolean;
  error: string | null;
  selected: ScenarioEntry | null;
  onSelect: (entry: ScenarioEntry) => void;
  onGo: () => void;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={COPY.dialogTitle}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.35)",
        zIndex: 99999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) props.onClose();
      }}
    >
      <div
        style={{
          background: "var(--dsw-specific-input-major, #fff)",
          color: "var(--dsw-alias-label-primary, #1a1a1a)",
          borderRadius: 12,
          boxShadow: "0 8px 40px rgba(0,0,0,.3)",
          width: "min(420px, calc(100vw - 32px))",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          fontSize: 14,
        }}
      >
        <div
          style={{
            padding: "14px 16px",
            borderBottom: "1px solid var(--dsw-alias-border-l2, #e5e7eb)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <strong style={{ fontSize: 15 }}>{COPY.dialogTitle}</strong>
          <button
            type="button"
            aria-label="关闭"
            onClick={props.onClose}
            style={{
              marginLeft: "auto",
              background: "none",
              border: "none",
              fontSize: 18,
              lineHeight: 1,
              cursor: "pointer",
              color: "var(--dsw-alias-label-tertiary, #6b7280)",
              padding: "4px 6px",
            }}
          >
            ×
          </button>
        </div>
        <div style={{ padding: "12px 16px", overflow: "auto", minHeight: 80 }}>
          {props.scenarios.length === 0 ? (
            <div style={{ opacity: 0.6, padding: "20px 0", textAlign: "center" }}>
              {props.error ?? COPY.empty}
            </div>
          ) : (
            props.scenarios.map((s) => (
              <label
                key={`${s.source}:${s.name}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "9px 10px",
                  border: "1px solid var(--dsw-alias-border-l2, #e5e7eb)",
                  borderRadius: 8,
                  marginBottom: 8,
                  cursor: "pointer",
                  background: "var(--dsw-alias-bg-module-platform, #fafafa)",
                }}
              >
                <input
                  type="radio"
                  name="xzg-scenario"
                  value={scenarioKey(s)}
                  // 受控单选：勾选态由 selected state 派生，显示与提交严格一致。
                  checked={props.selected !== null && scenarioKey(props.selected) === scenarioKey(s)}
                  onChange={() => props.onSelect(s)}
                />
                <span style={{ fontWeight: 500 }}>{s.name}</span>
                <span style={{ marginLeft: "auto", fontSize: 12, opacity: 0.55 }}>
                  {s.source === "project" ? COPY.projectBadge : s.source}
                </span>
              </label>
            ))
          )}
        </div>
        <div
          style={{
            padding: "10px 16px",
            borderTop: "1px solid var(--dsw-alias-border-l2, #e5e7eb)",
          }}
        >
          {props.error && props.scenarios.length > 0 ? (
            <div style={{ color: "#cf222e", fontSize: 13, marginBottom: 8 }}>{props.error}</div>
          ) : null}
          {props.selected === null && props.scenarios.length > 0 && !props.error ? (
            <div style={{ opacity: 0.6, fontSize: 13, marginBottom: 8 }}>{COPY.pickHint}</div>
          ) : null}
          <button
            type="button"
            disabled={props.busy || props.selected === null}
            onClick={props.onGo}
            style={{
              width: "100%",
              padding: "9px 0",
              border: "none",
              borderRadius: 8,
              background: "var(--dsw-static-deepseek-500, #2da44e)",
              color: "#fff",
              fontSize: 14,
              cursor: props.busy ? "wait" : props.selected === null ? "not-allowed" : "pointer",
              opacity: props.busy || props.selected === null ? 0.5 : 1,
            }}
          >
            {props.busy ? COPY.creating : COPY.go}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 输入框内「创建团队」按钮组件（conversation.input.right 插槽）。
 * 0.1.2-rc.1 起插槽不再提供 owner 数据面（D-1）：sessionId 经 register spec
 * 的 inject(sessionId) 通道注入（宿主渲染当前会话时调用，官方 input.dock /
 * trajectory 同款形态）；blank 位经 sessions.list 快照订阅（useSyncExternalStore，
 * 与官方 trajectory 订阅同款）；draft 经 conversation.input.for(scope).state
 * 门面读取（创建时快照）。
 */
export function TeamCreateButton(props: { sessionId?: string }) {
  const sessionId = props.sessionId ?? "";
  const [open, setOpen] = useState(false);
  const [scenarios, setScenarios] = useState<ScenarioEntry[]>([]);
  const [selected, setSelected] = useState<ScenarioEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isTeam, setIsTeam] = useState(false);
  const loadedRef = useRef(false);
  const cwdRef = useRef<string | undefined>(undefined);

  // 首轮位（blank）订阅 sessions.list 快照：byId[sessionId].blank 翻转即
  // re-render（发消息后自动翻 false → 按钮隐藏；切会话 → 换行判定）。
  const sessionBlank = useSyncExternalStore(
    (cb) => sessionsService?.list.subscribe(cb) ?? (() => {}),
    () => {
      const list = sessionsService?.list.getSnapshot();
      return list?.byId[sessionId as Parameters<ISessions["scope"]>[0]]?.blank ?? false;
    },
  );

  // 建团状态探测：随会话重置（切到已建团会话立即隐藏按钮），仅首轮探测。
  useEffect(() => {
    loadedRef.current = false;
    cwdRef.current = undefined;
    setIsTeam(false);
    if (!sessionBlank || !sessionId) return;
    loadedRef.current = true;
    let cancelled = false;
    fetchTimeout(`/api/xiaozhuge/team/status?session=${encodeURIComponent(sessionId)}`)
      .then((r) => r.json())
      .then((d: TeamStatus) => {
        if (!cancelled) setIsTeam(d.is_team === true);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [sessionId, sessionBlank]);

  // 仅首轮（blank 且未建团）展示。
  if (!sessionBlank || isTeam) return null;

  async function loadScenarios(): Promise<ScenarioEntry[]> {
    // 工作区随会话推导：ctx.sessions.list 快照的 byId[sessionId].cwd（会话工作
    // 目录，官方服务方法面 ObservableSnapshot，非旧 connection.api RPC）→
    // project 层模板可见。
    try {
      const list = sessionsService?.list.getSnapshot();
      cwdRef.current = list?.byId[sessionId]?.cwd;
    } catch {
      // cwd 缺失仅影响 project 层模板；builtin/user 仍可用。
    }
    const url = `/api/xiaozhuge/team/scenarios${cwdRef.current ? `?workspace=${encodeURIComponent(cwdRef.current)}` : ""}`;
    const r = await fetchTimeout(url).then((res) => res.json());
    return (r.scenarios ?? []) as ScenarioEntry[];
  }

  function openPicker() {
    setOpen(true);
    setError(null);
    // 不预选（issue 82）：selected 保持 null，创建按钮禁用直至用户显式点击；
    // 唯一事实源即此 state，radio 勾选态与提交值均由它派生。
    setSelected(null);
    void loadScenarios()
      .then((list) => {
        setScenarios(list);
      })
      .catch((e: Error) => {
        setScenarios([]);
        setError(`${COPY.loadFailed}：${e.message}`);
      });
  }

  async function createTeam() {
    if (busy || selected === null) return;
    const entry = selected;
    // 快照当前会话与草稿（异步期间用户可能切换会话/输入）。
    const targetSession = sessionId;
    // 0.1.2-rc.1（D-1）：draft 不再来自插槽 owner props，改经 conversation.input
    // 门面读取（SessionInputShell.state 发布 InputState；scope 未就绪视为空草稿——
    // 仅影响「我的任务」前缀，不阻断建团）。
    let draft = "";
    if (sessionsService !== null && conversationService !== null) {
      const scopeCtx = sessionsService.scope(targetSession as Parameters<ISessions["scope"]>[0]);
      if (scopeCtx) {
        draft = (conversationService.input.for(scopeCtx).state.getSnapshot().draft ?? "").trim();
      }
    }
    setBusy(true);
    setError(null);
    try {
      // ① 服务端 init 持久化（同源 REST 端点，双头断言由服务端执行）。
      const created = await fetchTimeout("/api/xiaozhuge/team/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session: targetSession,
          scenario: entry.name,
          source: entry.source,
          // 工作区随会话推导（session.list cwd），无需用户填写。
          ...(cwdRef.current ? { workspace: cwdRef.current } : {}),
        }),
      }).then((r) => r.json());
      if (!created?.ok) {
        const msg = created?.error?.message ?? created?.error?.code ?? "创建失败";
        throw new Error(msg);
      }
      // ② 投递 tier0_prompt 到当前会话（输入框草稿作首条用户任务）。
      // 0.1.2 官方形态：ctx.sessions.scope(id).get("conversation").send(text)
      // （scope-addressed 会话门面；必须显式 get——conversation 服务提供在
      // dsh-client-ui-conversation 插件 fiber，scope ctx 与其是兄弟子树，
      // 属性访问 scopeCtx.conversation 沿 fiber 祖先链回溯不到 → cordis 抛
      // `cannot get property "conversation" without inject`；get() 走共享
      // root 存储任意 ctx 可解析，且返回服务的 this.ctx 仍绑定调用者 scope
      // （官方内部 scopedConversation() 即此形态）。send 失败走 reject 进外层 catch）。
      const bootText = `${BOOT_MESSAGE_HEAD}\n\n${created.tier0_prompt}`;
      const promptText = draft ? `【我的任务】${draft}\n\n${bootText}` : bootText;
      const scopeCtx = sessionsService?.scope(targetSession as Parameters<ISessions["scope"]>[0]);
      if (!scopeCtx) throw new Error("会话作用域不可用");
      const conversation = scopeCtx.get("conversation") as IConversation | undefined;
      if (!conversation) throw new Error("conversation 服务不可用");
      await conversation.send(promptText);
      // ③ 成功后清空目标会话草稿（issue 81）：任务文本已随 prompt 投递，
      // 残留易误重发；失败路径不走到这里，草稿保留便于重试。
      clearSessionDraft(targetSession);
      setIsTeam(true);
      setOpen(false);
    } catch (e) {
      setError(`${COPY.createFailed}：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        id="xzg-team-create-btn"
        title="选择团队场景并在本会话创建团队"
        onClick={() => openPicker()}
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
        }}
      >
        {COPY.button}
      </button>
      {open ? (
        <ScenarioPicker
          scenarios={scenarios}
          busy={busy}
          error={error}
          selected={selected}
          onSelect={setSelected}
          onGo={() => void createTeam()}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/**
 * 浏览器端插件装配：注册 conversation.input.right 插槽（建团按钮 + 团队
 * tab 协调器）；绑定宿主服务句柄。
 * @param ctx - 客户端 cordis 上下文。
 */
export function apply(ctx: Context): void {
  // 注入宿主服务句柄：sessions（0.1.2 官方 ISessions 服务方法面：scope/scopeOf/
  // list 等）+ conversation（input 门面注册表）。组件经模块级引用使用。
  sessionsService = (ctx.get("sessions") as ISessions | undefined) ?? null;
  conversationService = (ctx.get("conversation") as IConversation | undefined) ?? null;
  // 成员「打开会话」导航面（ISessions 公开契约子集：open/openSubagent/
  // subagentAddress/refreshSubagents）。
  bindSessionsService(
    (ctx.get("sessions") as unknown as Parameters<typeof bindSessionsService>[0] | undefined) ?? null,
  );
  const slots = ctx.get("slots") as {
    inject: (key: string, callback: () => unknown) => void;
    register: <P>(
      spec: {
        name: string;
        id: string;
        order?: number;
        label?: string;
        /** 0.1.2-rc.1（D-1）官方数据通道：宿主渲染条目时以当前会话 id 调用。 */
        inject?: (sessionId: string) => object;
      },
      component: (props: P) => unknown,
    ) => () => void;
  };
  slotsService = slots;
  slots.inject("conversation.input.right", () =>
    slots.register(
      {
        name: "conversation.input.right",
        id: "xiaozhuge-team-create",
        order: 0,
        inject: (sessionId) => ({ sessionId }),
      },
      TeamCreateButton,
    ),
  );
  // 团队 tab 存在性协调器（issue 68）：插槽无按会话显隐字段，动态
  // register/dispose 实现「非团队会话不出现」；恒驻 input.right 条目承载
  // 探测 hooks（渲染 null，零视觉占位）。
  slots.inject("conversation.input.right", () =>
    slots.register(
      {
        name: "conversation.input.right",
        id: "xiaozhuge-team-view-watcher",
        order: 1,
        inject: (sessionId) => ({ sessionId }),
      },
      TeamViewWatcher,
    ),
  );
  // #163 Q1：子代理会话页「返回团队」入口（官方 header.actions 插槽，additive
  // 按钮位）。仅 member 会话渲染（组件内 self-hide），root/none 零视觉占位；
  // 与团队 tab 并存不重复——按钮定位为「返回团队主会话」快捷位。
  slots.inject("conversation.session.header.actions", () =>
    slots.register(
      {
        name: "conversation.session.header.actions",
        id: "xiaozhuge-team-back-nav",
        order: 0,
        inject: (sessionId) => ({ sessionId }),
      },
      TeamBackNavEntry,
    ),
  );
}

/** 模块级 slots 句柄（协调器动态注册团队 tab 用）。 */
let slotsService: {
  register: <P>(
    spec: {
      name: string;
      id: string;
      order?: number;
      label?: string;
      /** 0.1.2-rc.1（D-1）官方数据通道：宿主渲染条目时以当前会话 id 调用。 */
      inject?: (sessionId: string) => object;
    },
    component: (props: P) => unknown,
  ) => () => void;
} | null = null;

/** 团队 view entry 当前 disposer（null = 未注册）。 */
let teamViewDisposer: (() => void) | null = null;

/** 团队 tab 注册参数：order 20 排在对话与轨迹(order 10)之后。 */
const TEAM_VIEW_SPEC = {
  name: "conversation.view",
  id: "xiaozhuge-team-view",
  order: 20,
  label: "团队",
  // D-1：view 条目同走 inject(sessionId) 官方通道（trajectory 先例）。
  inject: (sessionId: string) => ({ sessionId }),
} as const;

/** 按期望状态注册/注销团队 tab（幂等）。 */
export function setTeamViewTab(present: boolean): void {
  if (present && teamViewDisposer === null && slotsService !== null) {
    teamViewDisposer = slotsService.register(TEAM_VIEW_SPEC, TeamView);
  } else if (!present && teamViewDisposer !== null) {
    teamViewDisposer();
    teamViewDisposer = null;
  }
}

/**
 * 团队 tab 存在性协调器：随当前会话探测 team/status，is_team 时注册 tab、
 * 否则注销。dispose 即刻生效（切走立即消失），register 在探测完成后（团队
 * 会话首次切入约一个 RTT 后出现）——时序毛边为 v1 已知取舍。
 */
export function TeamViewWatcher(props: { sessionId?: string }): null {
  const sessionId = props.sessionId ?? "";
  useEffect(() => {
    let cancelled = false;
    if (!sessionId) {
      setTeamViewTab(false);
      return;
    }
    fetchTimeout(`/api/xiaozhuge/team/status?session=${encodeURIComponent(sessionId)}`)
      .then((r) => r.json())
      .then((d: TeamStatus) => {
        if (!cancelled) setTeamViewTab(d.is_team === true);
      })
      .catch(() => {
        // 探测失败保持现状（不误删已呈现的 tab）。
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  // 插件卸载兜底清理。
  useEffect(() => () => setTeamViewTab(false), []);
  return null;
}
