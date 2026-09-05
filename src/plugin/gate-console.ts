/**
 * Gate Console 与 resolve HTTP 面（P5，按 #2/#3/#9 修正口径）。
 *
 * 安全语义 = MVP 最小集（#2 挂起决定，#2 评审修订后收口）：
 * - POST 一律要求同源 Origin（CSRF 补丁定性）+ Sec-Fetch-Site 断言
 *   （存在且非 same-origin 即拒；缺失放行兼容老设备）——双头互证为跨站
 *   防御纵深冗余，**不防**具备 HTTP 能力的 agent 自批（残余风险接受 +
 *   审计检测：UA 指纹 + SFS 归类 + 远端 IP 入审计事件）；
 * - Console 渲染全量转义 + 每请求 nonce CSP（防放置恶意 gate 触发同源 XSS）。
 * 反自批中间件 / human-present challenge 待 Gate 能力重设计（#53）。
 *
 * Console 页面由 host 直出内联 HTML（零构建）：直读 gates/*.json 渲染
 * pending 区块（ADR 0003/#3 最终决策），批准后状态自然刷新。
 */
import { readdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { join } from "node:path";
import { isValidSessionId } from "./session-id.js";
import { resolveDshHome } from "./team-home.js";
import {
  listGates,
  openGate,
  resolveGate,
  EventLog,
  ensureDir,
  layout,
  validateGateId,
} from "../runtime/index.js";

/** 路由前缀。 */
export const ROUTES_PREFIX = "/api/xiaozhuge";
/** Console 页面路径。 */
export const ROUTES_CONSOLE = "/xiaozhuge/console";

interface GateRouteDeps {
  /** 主会话 id → 实例根 TEAM_HOME。 */
  teamHomeFor: (sessionId: string) => string;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) raw += String(chunk);
  return raw;
}

/** 同源 Origin 校验：Origin 缺失（非浏览器）或与 Host 异源即拒。 */
export function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return false; // POST 无 Origin = 非浏览器客户端，拒
  try {
    const originHost = new URL(origin).host;
    const hostHeader = req.headers.host ?? "";
    return originHost === hostHeader;
  } catch {
    return false;
  }
}

/** UA 指纹（审计用：不存原文，存长度+尾 6 字符哈希式摘要）。 */
function uaFingerprint(req: IncomingMessage): string {
  const ua = req.headers["user-agent"] ?? "";
  return `len${ua.length}:${ua.slice(-6)}`;
}

/**
 * Fetch Metadata 断言（#2 P0，真值表语义固化）：
 * - Sec-Fetch-Site 存在且 ≠ same-origin → 拒（明确跨站信号）；
 * - 头缺失（老内核/非浏览器客户端）→ 放行——兼容 iOS < 16.4 等无此头设备；
 *   负例放行是刻意选择，勿改为缺失即拒（会砸掉老设备合法用户）。
 * 定性：跨站防御的纵深冗余（与 Origin 双头互证），**不防**具备 HTTP 能力的
 * agent 自批——自批属残余风险接受 + 审计检测措施（ADR 0010）。
 */
export function fetchSiteAllowed(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin";
}

/** SFS 取值归类（审计标记用）。 */
function sfsMarker(req: IncomingMessage): string {
  const site = req.headers["sec-fetch-site"];
  return site === undefined ? "absent-legacy" : String(site);
}

/** 实例摘要（#195 U0-b）：Console 打开即见的定位数据面。 */
export interface TeamInstanceSummary {
  /** 主会话 id（实例根目录名）。 */
  session: string;
  /** pending 态 gate 数（只回计数，不回 gate 内容——信息分层，内容仍按需凭 session 取）。 */
  pendingCount: number;
  /** 最近活跃时间 = team.yaml mtime（epoch ms）；缺 team.yaml 的目录不是实例，已过滤。 */
  lastActiveMs: number;
}

/**
 * 枚举 `<DSH_HOME>/xiaozhuge/sessions/*` 下的团队实例，按最近活跃降序。
 *
 * 成本定性（#195 评审 B2 修正）：Console 打开时一次、目录深度 1、每目录
 * 一次 team.yaml stat + gates 目录 readdir——与 #173 消灭的「每工具调用
 * 全库会话扫描」不同量级，不复辟全扫模式。目录名经 session id 白名单
 * 过滤（#103/#180 口径），白名单外的目录直接跳过。
 */
export async function listInstances(dshHome: string = resolveDshHome()): Promise<TeamInstanceSummary[]> {
  const sessionsRoot = join(dshHome, "xiaozhuge", "sessions");
  let names: string[];
  try {
    names = await readdir(sessionsRoot);
  } catch {
    return []; // 无 sessions 根（未建过团）= 空态，不是错误
  }
  const summaries: TeamInstanceSummary[] = [];
  for (const name of names) {
    if (!isValidSessionId(name)) continue;
    const teamHome = join(sessionsRoot, name);
    let lastActiveMs: number;
    try {
      lastActiveMs = (await stat(join(teamHome, "team.yaml"))).mtimeMs;
    } catch {
      continue; // 缺 team.yaml = 未初始化目录，不算实例
    }
    let pendingCount = 0;
    try {
      const { gates } = await listGates(layout(teamHome).gatesDir);
      pendingCount = gates.filter((g) => g.status === "pending").length;
    } catch {
      // 无 gates 目录 = 0 pending
    }
    summaries.push({ session: name, pendingCount, lastActiveMs });
  }
  return summaries.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
}

export function makeGateRoutes(deps: GateRouteDeps): WebRoute[] {
  return [
    {
      kind: "exact",
      path: `${ROUTES_PREFIX}/gates`,
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const sessionId = url.searchParams.get("session");
        if (!sessionId) {
          writeJson(res, 400, { error: "missing session parameter" });
          return;
        }
        // 白名单防御（issue #103）：sessionId 进入文件系统寻址前校验，
        // 错误码对齐 overview 口径。
        if (!isValidSessionId(sessionId)) {
          writeJson(res, 400, { error: "invalid session parameter" });
          return;
        }
        const teamLayout = layout(deps.teamHomeFor(sessionId));
        const gatesDir = teamLayout.gatesDir;
        if (req.method === "GET") {
          writeJson(res, 200, await listGates(gatesDir));
          return;
        }
        // POST open gate（Tier-0 工具面之外的补充通道，供测试/人工放置）
        if (req.method === "POST") {
          // 安全最小集：同源 Origin + Fetch Metadata 断言（双头互证）。
          if (!originAllowed(req)) {
            writeJson(res, 403, { error: "forbidden: missing or cross-origin Origin header" });
            return;
          }
          if (!fetchSiteAllowed(req)) {
            writeJson(res, 403, { error: "forbidden: cross-site Sec-Fetch-Site" });
            return;
          }
          try {
            const body = JSON.parse(await readBody(req)) as { id?: string; reason?: string; requestedBy?: string };
            if (typeof body.id !== "string" || body.id.length === 0) {
              writeJson(res, 400, { error: "id required" });
              return;
            }
            // P0-2（#180）：gate id 入路径前白名单早校验（`${id}.json` 拼文件）。
            if (!validateGateId(body.id)) {
              writeJson(res, 400, { error: "invalid gate id parameter" });
              return;
            }
            await ensureDir(gatesDir);
            const gate = await openGate(gatesDir, {
              id: body.id,
              reason: body.reason ?? "",
              requestedBy: body.requestedBy ?? "console",
            });
            // 字段级审计事件（#189，ADR 0018 兑现）：形状逐字段对齐 resolve
            // 分支（who/when/gate id/UA 指纹/SFS 归类/远端 IP/结果）。审计
            // append 在 openGate 之后：gate-exists 重试无副作用、无重复事件
            // （重试安全）；append 失败 → 409 的 fail-open 残余与 resolve
            // 分支同面，定性见 issue #189 评审评论（归 #53 评估）。
            await ensureDir(teamLayout.roomsDir);
            await ensureDir(join(teamLayout.roomsDir, "root"));
            const auditLog = new EventLog(join(teamLayout.roomsDir, "root", "events.jsonl"));
            await auditLog.init();
            await auditLog.append({
              session_id: sessionId,
              actor: "gate-console",
              type: "gate/open",
              payload: {
                gate_id: gate.id,
                requested_by: gate.requestedBy,
                reason: gate.reason,
                ua_fingerprint: uaFingerprint(req),
                sec_fetch_site: sfsMarker(req),
                remote_ip: req.socket.remoteAddress ?? null,
                opened_at: gate.requestedAt,
              },
            });
            writeJson(res, 200, { ok: true, gate });
          } catch (error) {
            writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        writeJson(res, 405, { error: "method not allowed" });
      },
    },
    {
      kind: "exact",
      path: `${ROUTES_PREFIX}/gates/resolve`,
      handler: async (req, res) => {
        if (req.method !== "POST") {
          writeJson(res, 405, { error: "method not allowed" });
          return;
        }
        // 安全最小集：同源 Origin + Fetch Metadata 断言（双头互证，CSRF 补丁）。
        // 定性：不防具备 HTTP 能力的 agent 自批（残余风险接受 + 审计检测）。
        if (!originAllowed(req)) {
          writeJson(res, 403, { error: "forbidden: missing or cross-origin Origin header" });
          return;
        }
        if (!fetchSiteAllowed(req)) {
          writeJson(res, 403, { error: "forbidden: cross-site Sec-Fetch-Site" });
          return;
        }
        try {
          const body = JSON.parse(await readBody(req)) as {
            session?: string;
            gate_id?: string;
            decision?: string;
            by?: string;
          };
          if (!body.session || !body.gate_id || (body.decision !== "approved" && body.decision !== "denied")) {
            writeJson(res, 400, { error: "session, gate_id and decision(approved|denied) required" });
            return;
          }
          // 白名单防御（issue #103）：对齐 overview 口径。
          if (!isValidSessionId(body.session)) {
            writeJson(res, 400, { error: "invalid session parameter" });
            return;
          }
          // P0-2（#180）：gate id 入路径前白名单早校验。
          if (!validateGateId(body.gate_id)) {
            writeJson(res, 400, { error: "invalid gate id parameter" });
            return;
          }
          const teamHome = deps.teamHomeFor(body.session);
          const l = layout(teamHome);
          await ensureDir(l.gatesDir);
          await ensureDir(l.roomsDir);
          await ensureDir(join(l.roomsDir, "root"));
          const gate = await resolveGate(l.gatesDir, body.gate_id, body.decision, body.by ?? "human-web");
          // 字段级审计事件（who/when/gate id/UA 指纹/SFS 归类/远端 IP/结果）
          const log = new EventLog(join(l.roomsDir, "root", "events.jsonl"));
          await log.init();
          await log.append({
            session_id: body.session,
            actor: "gate-console",
            type: "gate/resolve",
            payload: {
              gate_id: body.gate_id,
              decision: body.decision,
              by: gate.resolvedBy,
              ua_fingerprint: uaFingerprint(req),
              sec_fetch_site: sfsMarker(req),
              remote_ip: req.socket.remoteAddress ?? null,
              resolved_at: gate.resolvedAt ?? null,
            },
          });
          writeJson(res, 200, { ok: true, gate });
        } catch (error) {
          writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: "exact",
      path: `${ROUTES_PREFIX}/gates/instances`,
      handler: async (req, res) => {
        // 只读枚举面（#195 U0-b）：无参返回全部实例摘要（最近活跃降序）。
        // 读侧-only、无写语义，不做 Origin 断言（与 GET gates 同口径）。
        if (req.method !== "GET") {
          writeJson(res, 405, { error: "method not allowed" });
          return;
        }
        writeJson(res, 200, { instances: await listInstances() });
      },
    },
  ];
}

/**
 * Console 页面（内联 HTML，直读 API 渲染；375px 可用 + 双主题）。
 * #2 P0 加固：全部插值经 esc() 转义——gate 内容是外部输入，防同源 XSS；
 * 事件委托替代内联 onclick；每请求 nonce CSP 见 makeConsoleRoute。
 * #195 U0-b 零门槛：去手填 session id——打开即取 gates/instances 定位
 * 最近活跃实例；「其他实例」显式展开防跨实例误批；?session= 直达保留
 * （团队 tab 内嵌兼容）。
 */
export function consolePageHtml(nonce: string): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>小诸葛 Gate Console</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 12px; background: #f6f7f9; color: #1a1a1a; }
  @media (prefers-color-scheme: dark) { body { background: #14161a; color: #e8e8ea; } .card { background: #1e2128 !important; border-color: #33383f !important; } }
  h1 { font-size: 18px; margin: 8px 0 4px; }
  .hint { font-size: 12px; opacity: .65; margin-bottom: 10px; }
  input { width: 100%; box-sizing: border-box; padding: 6px 8px; margin-bottom: 8px; border: 1px solid #bbb; border-radius: 6px; background: inherit; color: inherit; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 10px; margin-bottom: 8px; background: #fff; max-width: 720px; }
  .pending { border-left: 4px solid #e6a700; }
  .approved { border-left: 4px solid #2da44e; opacity: .75; }
  .denied { border-left: 4px solid #cf222e; opacity: .75; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  button { padding: 6px 14px; border-radius: 6px; border: none; cursor: pointer; font-size: 13px; }
  button.ghost { border: 1px solid #bbb; background: inherit; color: inherit; width: 100%; text-align: left; margin-bottom: 6px; }
  .approve { background: #2da44e; color: #fff; }
  .deny { background: #cf222e; color: #fff; }
  code { font-size: 12px; }
  .empty { opacity: .6; padding: 16px 0; }
</style>
</head>
<body>
<h1>Gate 待办</h1>
<div class="hint"><span id="inst">定位中…</span> <button id="refresh">刷新</button></div>
<div id="msg" class="hint" style="color: #2da44e; margin-bottom: 8px;" hidden></div>
<details id="switch" hidden><summary>其他实例</summary><div id="instlist"></div></details>
<div id="list"><div class="empty">正在定位最近活跃实例…</div></div>
<script nonce="${nonce}">
const $ = (s) => document.querySelector(s);
// 浏览器→dsh web 一跳超时兜底（ADR 0021）：半开连接下裸 fetch 挂到 TCP 重传
// 超时（可达 15 分钟）。AbortSignal.timeout 需 Safari 15.4+/iOS 15.4+；更旧环境
// 不注入（低频操作，依赖浏览器自身超时）。
const connTimeoutSignal = () =>
  typeof AbortSignal.timeout === "function" ? { signal: AbortSignal.timeout(10000) } : {};
// 全部插值转义：gate 内容是外部输入，防同源 XSS（#2 P0）
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// 当前实例 session（#195 U0-b）：?session= 直达优先（团队 tab 内嵌兼容），
// 否则取 instances[0]（最近活跃）。未定位前 resolve 一律拒绝（防误批空实例）。
let currentSession = null;
const short = (s) => String(s).slice(0, 8);
function fmtAgo(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return "刚刚";
  if (m < 60) return m + " 分钟前";
  return Math.round(m / 60) + " 小时前";
}
async function locate() {
  // 直达：URL 显式带 session（团队 tab 内嵌 #51），跳过枚举
  const qsSession = new URLSearchParams(location.search).get("session");
  if (qsSession) { currentSession = qsSession; return; }
  let data;
  try {
    const r = await fetch("/api/xiaozhuge/gates/instances", connTimeoutSignal());
    data = await r.json();
  } catch { $("#inst").textContent = "实例定位失败——点「刷新」重试。"; return; }
  const inst = data.instances ?? [];
  if (inst.length === 0) {
    $("#inst").textContent = "暂无团队实例——先建团，待办会出现在这里。";
    $("#list").innerHTML = '<div class="empty">无实例。</div>';
    return;
  }
  currentSession = inst[0].session;
  renderInst();
  // 其余实例给显式切换入口（跨实例聚合默认关闭，防在错误实例上误批）
  if (inst.length > 1) {
    $("#switch").hidden = false;
    $("#instlist").innerHTML = inst.slice(1).map((i) => \`
      <button class="ghost" data-switch="\${esc(i.session)}">
        <code>\${esc(short(i.session))}</code> · pending \${i.pendingCount} · \${esc(fmtAgo(i.lastActiveMs))}
      </button>\`).join("");
  }
}
function renderInst() {
  $("#inst").innerHTML = \`实例 <code>\${esc(short(currentSession))}</code>\`;
}
async function load() {
  if (!currentSession) return;
  const r = await fetch(\`/api/xiaozhuge/gates?session=\${encodeURIComponent(currentSession)}\`, connTimeoutSignal());
  const data = await r.json();
  render(data.gates ?? []);
}
function render(gates) {
  const el = $("#list");
  if (gates.length === 0) { el.innerHTML = '<div class="empty">暂无 gate。</div>'; return; }
  el.innerHTML = gates.map((g) => \`
    <div class="card \${esc(g.status)}">
      <div class="row"><code>\${esc(g.id)}</code><strong>\${esc(g.status)}</strong></div>
      <div>\${esc(g.reason)}</div>
      <div class="hint">by \${esc(g.requestedBy)}</div>
      \${g.status === "pending" ? \`
      <div class="row">
        <button class="approve" data-act="approved" data-gid="\${esc(g.id)}">批准</button>
        <button class="deny" data-act="denied" data-gid="\${esc(g.id)}">驳回</button>
      </div>\` : ""}
    </div>\`).join("");
}
async function resolve(gateId, decision) {
  if (!currentSession) return; // 未定位实例前不做任何裁决
  const r = await fetch("/api/xiaozhuge/gates/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: currentSession, gate_id: gateId, decision, by: "human-web" }),
    ...connTimeoutSignal(),
  });
  if (!r.ok) {
    alert((await r.json()).error ?? "failed");
  } else {
    const msg = $("#msg");
    if (msg) {
      msg.hidden = false;
      msg.textContent = "Gate 裁决已写入。若主控处于等待/阻塞状态，请回到主会话聊天窗口发送「已批准，请继续」唤醒主控。";
    }
  }
  await load();
}
$("#refresh").addEventListener("click", () => { currentSession = null; $("#inst").textContent = "定位中…"; $("#switch").hidden = true; void locate().then(load); });
$("#list").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-act]");
  if (btn) void resolve(btn.dataset.gid, btn.dataset.act);
});
$("#instlist").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-switch]");
  if (!btn) return;
  currentSession = btn.dataset.switch;
  $("#switch").open = false;
  renderInst();
  void load();
});
// 打开即定位 + 加载（零手填，#195）；renderInst 在 locate 成功路径内执行
// （空态/失败分支不得渲染「实例 null」）；窗口重聚焦时轻拉一次（无常驻轮询）
void locate().then(load);
window.addEventListener("focus", () => { if (currentSession) void load(); });
</script>
</body>
</html>`;
}

/** Console 页面路由（GET 直出；每请求随机 nonce CSP，#2 P0）。 */
export function makeConsoleRoute(): WebRoute {
  return {
    kind: "exact",
    path: ROUTES_CONSOLE,
    handler: async (_req, res) => {
      const nonce = randomUUID();
      const csp =
        `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
        `connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`;
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": csp,
      });
      res.end(consolePageHtml(nonce));
    },
  };
}

/** 枚举 gates 目录（诊断辅助，未导出到协议面）。 */
export async function countGates(gatesDir: string): Promise<number> {
  try {
    return (await readdir(gatesDir)).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}
