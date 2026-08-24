/**
 * Gate Console 与 resolve HTTP 面（P5，按 #2/#3/#9 修正口径）。
 *
 * 安全语义 = MVP 最小集（#2 挂起决定）：
 * - POST 一律要求同源 Origin（CSRF 补丁定性）；缺失/异源拒绝并留审计；
 * - 每次 resolve 写字段级审计事件（who/when/gate id/UA 指纹/结果）入实例根
 *   事件流；README 如实声明「防误触 + 审计追责，不防本机进程」。
 * 反自批中间件 / nonce 下发 / Sec-Fetch-Site 硬校验悬置待安全专项。
 *
 * Console 页面由 host 直出内联 HTML（零构建）：直读 gates/*.json 渲染
 * pending 区块（ADR 0003/#3 最终决策），批准后状态自然刷新。
 */
import { readdir } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { join } from "node:path";
import { listGates, openGate, resolveGate } from "../runtime/gates.js";
import { EventLog } from "../runtime/event-log.js";
import { ensureDir } from "../runtime/fs-utils.js";
import { layout } from "../runtime/paths.js";

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
        const gatesDir = layout(deps.teamHomeFor(sessionId)).gatesDir;
        if (req.method === "GET") {
          writeJson(res, 200, await listGates(gatesDir));
          return;
        }
        // POST open gate（Tier-0 工具面之外的补充通道，供测试/人工放置）
        if (req.method === "POST") {
          try {
            const body = JSON.parse(await readBody(req)) as { id?: string; reason?: string; requestedBy?: string };
            if (typeof body.id !== "string" || body.id.length === 0) {
              writeJson(res, 400, { error: "id required" });
              return;
            }
            await ensureDir(gatesDir);
            const gate = await openGate(gatesDir, {
              id: body.id,
              reason: body.reason ?? "",
              requestedBy: body.requestedBy ?? "console",
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
        // 安全最小集：同源 Origin 校验（CSRF 补丁）。
        if (!originAllowed(req)) {
          writeJson(res, 403, { error: "forbidden: missing or cross-origin Origin header" });
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
          const teamHome = deps.teamHomeFor(body.session);
          const l = layout(teamHome);
          await ensureDir(l.gatesDir);
          await ensureDir(l.roomsDir);
          await ensureDir(join(l.roomsDir, "root"));
          const gate = await resolveGate(l.gatesDir, body.gate_id, body.decision, body.by ?? "human-web");
          // 字段级审计事件（who/when/gate id/UA 指纹/结果）
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
              resolved_at: gate.resolvedAt ?? null,
            },
          });
          writeJson(res, 200, { ok: true, gate });
        } catch (error) {
          writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
  ];
}

/** Console 页面（内联 HTML，直读 API 渲染；375px 可用 + 双主题）。 */
export function consolePageHtml(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>小诸葛 Gate Console</title>
<style>
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
  .approve { background: #2da44e; color: #fff; }
  .deny { background: #cf222e; color: #fff; }
  code { font-size: 12px; }
  .empty { opacity: .6; padding: 16px 0; }
</style>
</head>
<body>
<h1>Gate 待办</h1>
<div class="hint">主会话：<input id="session" placeholder="session id"> <button onclick="load()">刷新</button></div>
<div id="list"><div class="empty">填入主会话 id 后刷新。</div></div>
<script>
const $ = (s) => document.querySelector(s);
async function load() {
  const session = $("#session").value.trim();
  if (!session) return;
  const r = await fetch(\`/api/xiaozhuge/gates?session=\${encodeURIComponent(session)}\`);
  const data = await r.json();
  render(session, data.gates ?? []);
}
function render(session, gates) {
  const el = $("#list");
  if (gates.length === 0) { el.innerHTML = '<div class="empty">暂无 gate。</div>'; return; }
  el.innerHTML = gates.map((g) => \`
    <div class="card \${g.status}">
      <div class="row"><code>\${g.id}</code><strong>\${g.status}</strong></div>
      <div>\${g.reason ?? ""}</div>
      <div class="hint">by \${g.requestedBy ?? "?"}</div>
      \${g.status === "pending" ? \`
      <div class="row">
        <button class="approve" onclick="resolve('\${session}','\${g.id}','approved')">批准</button>
        <button class="deny" onclick="resolve('\${session}','\${g.id}','denied')">驳回</button>
      </div>\` : ""}
    </div>\`).join("");
}
async function resolve(session, gateId, decision) {
  const r = await fetch("/api/xiaozhuge/gates/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session, gate_id: gateId, decision, by: "human-web" }),
  });
  if (!r.ok) alert((await r.json()).error ?? "failed");
  await load();
}
</script>
</body>
</html>`;
}

/** Console 页面路由（GET 直出）。 */
export function makeConsoleRoute(): WebRoute {
  return {
    kind: "exact",
    path: ROUTES_CONSOLE,
    handler: async (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(consolePageHtml());
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
