/**
 * Team 拉起入口 HTTP 面（#51，ADR 0011）：
 * 一键链路 = 入口页客户端编排同源调用——
 *   ① POST /api/workspace.create（宿主）→ ② POST /api/session.create（宿主）
 *   → ③ POST /api/xiaozhuge/team/create（本文件：服务端跑 init 持久化）
 *   → ④ POST /api/session.prompt 投递 tier0_prompt 首条消息。
 *
 * init 由此从 LLM 工具面移到 HTTP 面：team_init 工具下线，handler 逻辑
 * 保留复用。安全语义沿 Gate Console 先例：POST 同源 Origin + Fetch
 * Metadata 双头断言；scenario 运行时校验 builtin 白名单。
 */
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { IndexInjection, WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { resolveTeamHome, userTemplatesRoot, projectTemplatesRoot } from "./team-home.js";
import { createHandlers, PACKAGE_ROOT } from "./handlers.js";
import { layout, listScenarios } from "../runtime/index.js";
import { fetchSiteAllowed, originAllowed } from "./gate-console.js";

/** 独立入口页路径。 */
export const ROUTES_LAUNCH = "/xiaozhuge/launch";

/**
 * 宿主页面结构化注入（#51）：浮动入口 + 发送框旁快捷按钮 + 团队会话
 * 「团队」tab。DOM 定位依赖宿主前端结构，属已知脆弱点——独立页兜底。
 */
export function makeIndexInjections(): IndexInjection[] {
  return [{ kind: "script", placement: "body", text: INDEX_SCRIPT }];
}

const INDEX_SCRIPT = String.raw`
(function () {
  if (window.__XZG_INJECTED__) return;
  window.__XZG_INJECTED__ = true;
  var fab = document.createElement("a");
  fab.href = "/xiaozhuge/launch";
  fab.target = "_blank";
  fab.textContent = "创建团队";
  fab.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:99999;background:#2da44e;color:#fff;padding:8px 14px;border-radius:20px;font-size:13px;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.25)";
  document.body.appendChild(fab);
  var tries = 0;
  var timer = setInterval(function () {
    if (++tries > 30) { clearInterval(timer); return; }
    var box = document.querySelector("textarea, [contenteditable='true']");
    if (!box) return;
    var form = box.closest("form") || box.parentElement;
    if (!form || form.querySelector(".xzg-team-btn")) { clearInterval(timer); return; }
    var btn = document.createElement("a");
    btn.className = "xzg-team-btn";
    btn.href = "/xiaozhuge/launch";
    btn.target = "_blank";
    btn.textContent = "创建团队";
    btn.style.cssText = "white-space:nowrap;margin-left:6px;font-size:12px;padding:4px 10px;border-radius:14px;background:#2da44e;color:#fff;text-decoration:none;display:inline-block";
    form.appendChild(btn);
    clearInterval(timer);
  }, 1000);
  var currentSession = null;
  setInterval(function () {
    var m = (location.pathname + location.search).match(/sessions?[\/=]([A-Za-z0-9_-]{6,})/);
    var sid = m ? m[1] : null;
    if (!sid || sid === currentSession) return;
    currentSession = sid;
    fetch("/api/xiaozhuge/team/status?session=" + encodeURIComponent(sid))
      .then(function (r) { return r.json(); })
      .then(function (d) { injectTeamTab(sid, d.is_team === true); })
      .catch(function () {});
  }, 2000);
  function injectTeamTab(sid, isTeam) {
    var existing = document.getElementById("xzg-team-tab");
    var panel = document.getElementById("xzg-team-panel");
    if (!isTeam) {
      if (existing) existing.remove();
      if (panel) panel.remove();
      return;
    }
    if (existing && panel) return;
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "xzg-team-panel";
      panel.style.cssText = "display:none;position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:99998;";
      panel.innerHTML = '<div style="position:absolute;top:5%;left:5%;width:90%;height:90%;background:#fff;border-radius:10px;overflow:hidden"><iframe src="/xiaozhuge/console?session=' + encodeURIComponent(sid) + '" style="width:100%;height:100%;border:none"></iframe></div>';
      panel.addEventListener("click", function (ev) { if (ev.target === panel) panel.style.display = "none"; });
      document.body.appendChild(panel);
    }
    if (existing) return;
    var tabs = Array.prototype.slice.call(document.querySelectorAll("button,[role='tab'],a")).filter(function (el) {
      return /^(对话|聊天|轨迹|历史)$/.test((el.textContent || "").trim());
    });
    var last = tabs[tabs.length - 1];
    if (last && last.parentElement) {
      var tab = document.createElement(last.tagName === "A" ? "a" : "button");
      tab.id = "xzg-team-tab";
      tab.textContent = "团队";
      tab.addEventListener("click", function () { panel.style.display = "block"; });
      last.parentElement.insertBefore(tab, last.nextSibling);
    } else {
      var floatBtn = document.createElement("button");
      floatBtn.id = "xzg-team-tab";
      floatBtn.textContent = "团队视图";
      floatBtn.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:99997;padding:6px 12px;border-radius:16px;border:none;background:#57606a;color:#fff;font-size:12px;cursor:pointer";
      floatBtn.addEventListener("click", function () { panel.style.display = "block"; });
      document.body.appendChild(floatBtn);
    }
  }
})();
`;

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) raw += String(chunk);
  return raw;
}

/** 启动消息头（不含规程正文）；bootMessage 与页面脚本共用同一前缀。 */
export const BOOT_MESSAGE_HEAD =
  "团队已由人经入口创建，实例初始化完成。以下是你的 Tier-0 规程与场景编排" +
  "提示词全文（规程在前、场景段在后，以固定分隔符分界），请从启动对账节开始执行：";

/** 启动消息 = 前缀 + 组装好的 tier0_prompt。 */
export function bootMessage(tier0Prompt: string): string {
  return `${BOOT_MESSAGE_HEAD}\n\n${tier0Prompt}`;
}

/** Team 拉起入口路由组（scenarios/status/create API + 独立入口页）。 */
export function makeLaunchRoutes(): WebRoute[] {
  return [
    {
      kind: "exact",
      path: "/api/xiaozhuge/team/scenarios",
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const workspace = url.searchParams.get("workspace") || undefined;
        // 三级来源根组装（project 层可选，需 workspace 参数）
        const roots: Array<{ source: "builtin" | "user" | "project"; dir: string }> = [
          { source: "builtin", dir: join(PACKAGE_ROOT, "templates") },
          { source: "user", dir: userTemplatesRoot() },
        ];
        if (workspace) {
          roots.push({ source: "project", dir: projectTemplatesRoot(workspace) });
        }
        writeJson(res, 200, { scenarios: listScenarios(roots) });
      },
    },
    {
      kind: "exact",
      path: "/api/xiaozhuge/team/status",
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const sessionId = url.searchParams.get("session");
        if (!sessionId) {
          writeJson(res, 400, { error: "missing session parameter" });
          return;
        }
        const l = layout(resolveTeamHome(sessionId));
        // 团队会话判定：实例根已初始化（team.yaml 快照在场）。
        if (!existsSync(l.teamYaml)) {
          writeJson(res, 200, { is_team: false });
          return;
        }
        try {
          const snap = JSON.parse(readFileSync(l.teamYaml, "utf8")) as {
            name?: string;
            playbook_digest?: string;
          };
          writeJson(res, 200, {
            is_team: true,
            name: snap.name ?? null,
            playbook_digest: snap.playbook_digest ?? null,
          });
        } catch {
          writeJson(res, 200, { is_team: true, name: null, playbook_digest: null });
        }
      },
    },
    {
      kind: "exact",
      path: "/api/xiaozhuge/team/create",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          writeJson(res, 405, { error: "method not allowed" });
          return;
        }
        // 安全最小集：与 Gate Console 同款双头断言（复用同一实现）。
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
            scenario?: string;
            source?: string;
            workspace?: string;
            instance_note?: string;
          };
          if (typeof body.session !== "string" || body.session.length === 0) {
            writeJson(res, 400, { error: "session required" });
            return;
          }
          // handler 层负责 scenario 校验（unknown-scenario / ambiguous-scenario 稳定错误码）。
          const handlers = createHandlers(resolveTeamHome(body.session), body.session);
          const value = (await handlers.init({
            scenario: body.scenario,
            source: body.source,
            project_root: body.workspace,
            instance_note: body.instance_note,
          })) as Record<string, unknown>;
          writeJson(res, 200, value);
        } catch (error) {
          const e = error as { code?: string; message?: string };
          const status = e.code === "unknown-scenario" || e.code === "ambiguous-scenario" ? 400 : 409;
          writeJson(res, status, {
            error: { code: e.code ?? "internal-error", message: e.message ?? String(error) },
          });
        }
      },
    },
    {
      kind: "exact",
      path: ROUTES_LAUNCH,
      handler: async (_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(launchPageHtml());
      },
    },
  ];
}

/** 独立入口页（内联 HTML；一键编排 workspace→session→init→prompt 四步）。 */
export function launchPageHtml(): string {
  const headLiteral = JSON.stringify(BOOT_MESSAGE_HEAD);
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>小诸葛 · 创建团队</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; background: #f6f7f9; color: #1a1a1a; }
  @media (prefers-color-scheme: dark) { body { background: #14161a; color: #e8e8ea; } .card { background: #1e2128 !important; border-color: #33383f !important; } }
  h1 { font-size: 18px; margin: 8px 0 12px; }
  .card { border: 1px solid #ddd; border-radius: 10px; padding: 14px; background: #fff; max-width: 640px; margin-bottom: 12px; }
  label { display: block; font-size: 13px; margin: 10px 0 4px; }
  input, select { width: 100%; box-sizing: border-box; padding: 7px 9px; border: 1px solid #bbb; border-radius: 6px; background: inherit; color: inherit; font-size: 14px; }
  button { padding: 8px 18px; border-radius: 6px; border: none; cursor: pointer; font-size: 14px; background: #2da44e; color: #fff; margin-top: 12px; }
  button:disabled { opacity: .5; cursor: wait; }
  .hint { font-size: 12px; opacity: .65; margin-top: 6px; white-space: pre-wrap; }
  .err { color: #cf222e; font-size: 13px; margin-top: 8px; white-space: pre-wrap; }
</style>
</head>
<body>
<h1>创建团队</h1>
<div class="card">
  <label>工作区路径（宿主 workspace，绝对路径）</label>
  <input id="ws-path" placeholder="/path/to/workspace">
  <label>场景模板</label>
  <select id="scenario"></select>
  <label>备注（可选）</label>
  <input id="note" placeholder="instance note">
  <button id="go">一键建团并投递规程</button>
  <div class="err" id="err"></div>
  <div class="hint" id="log"></div>
</div>
<script>
const $ = (s) => document.querySelector(s);
const BOOT_HEAD = ${headLiteral};
const log = (m) => ($("#log").textContent += m + "\\n");
async function jfetch(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok && data.error) {
    throw new Error(typeof data.error === "object"
      ? (data.error.code + ": " + data.error.message)
      : String(data.error));
  }
  if (!r.ok) throw new Error("HTTP " + r.status);
  return data;
}
(async () => {
  const sel = $("#scenario");
  const list = (await jfetch("GET", "/api/xiaozhuge/team/scenarios")).scenarios;
  for (const s of list) {
    const o = document.createElement("option");
    o.value = s.name + "|" + s.source;
    o.textContent = s.name + " (" + s.source + ")";
    sel.appendChild(o);
  }
})();
$("#go").addEventListener("click", async () => {
  const btn = $("#go");
  btn.disabled = true;
  $("#err").textContent = "";
  $("#log").textContent = "";
  try {
    const wsPath = $("#ws-path").value.trim();
    if (!wsPath) throw new Error("请填写工作区路径");
    const ws = await jfetch("POST", "/api/workspace.create", { path: wsPath });
    log("workspace: " + ws.workspace.workspaceId);
    const sess = await jfetch("POST", "/api/session.create", {
      workspaceId: ws.workspace.workspaceId,
      agentPreset: "standard",
    });
    const sessionId = sess.sessionId;
    log("session: " + sessionId);
    const selVal = $("#scenario").value;
    const pipe = selVal.indexOf("|");
    const scenario = pipe >= 0 ? selVal.slice(0, pipe) : selVal;
    const source = pipe >= 0 ? selVal.slice(pipe + 1) : undefined;
    const created = await jfetch("POST", "/api/xiaozhuge/team/create", {
      session: sessionId,
      scenario: scenario,
      source: source,
      workspace: wsPath,
      instance_note: $("#note").value.trim() || null,
    });
    log("team initialized: " + created.home);
    await jfetch("POST", "/api/session.prompt", {
      sessionId,
      mode: "queue",
      content: [{ type: "text", text: BOOT_HEAD + "\\n\\n" + created.tier0_prompt }],
    });
    log("规程已投递。打开会话 " + sessionId + " 即可开始。");
  } catch (e) {
    $("#err").textContent = String(e.message ?? e);
  } finally {
    btn.disabled = false;
  }
});
</script>
</body>
</html>`;
}
