/**
 * Team 拉起入口 HTTP 面（#51，ADR 0011；#51 修订：入口收敛进会话内）。
 *
 * 一键链路（浏览器端 client 插件在输入框内完成，不再打开独立页）：
 *   ① session.list 推导当前会话（blank 首轮判定 + cwd 工作区推导）
 *   → ② POST /api/xiaozhuge/team/create（本文件：服务端跑 init 持久化）
 *   → ③ POST /api/session.prompt 投递 tier0_prompt 首条消息
 *     （输入框草稿作为首条用户任务，空则只投递规程）。
 *
 * init 由此从 LLM 工具面移到 HTTP 面：team_init 工具下线，handler 逻辑
 * 保留复用。安全语义沿 Gate Console 先例：POST 同源 Origin + Fetch
 * Metadata 双头断言；scenario 运行时校验 builtin 白名单。
 *
 * 输入框内「创建团队」按钮与场景浮层由客户端插件（src/client/）经
 * conversation.input.right 官方插槽渲染（ADR 0014）。
 */
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { resolveTeamHome, resolveTeamHomeForView, userTemplatesRoot, projectTemplatesRoot } from "./team-home.js";
import { createHandlers, PACKAGE_ROOT, rootCaller } from "./handlers.js";
import { layout, listScenarios } from "../runtime/index.js";
import { fetchSiteAllowed, originAllowed } from "./gate-console.js";
import { isValidSessionId } from "./session-id.js";

/** 独立入口页路径（保留为兜底；client 插件不再跳转此页）。 */
export const ROUTES_LAUNCH = "/xiaozhuge/launch";

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) raw += String(chunk);
  return raw;
}

/** 启动消息头（不含规程正文）；bootMessage 与页面脚本共用同一前缀。
 * 尾部附首 turn 检查单（#79 L2）：注意力聚焦三件事，规程正文不再依赖跳读。 */
export const BOOT_MESSAGE_HEAD =
  "团队已由人经入口创建，实例初始化完成。以下是你的 Tier-0 规程与场景编排" +
  "提示词全文（规程在前、场景段在后，以固定分隔符分界），请从启动对账节开始执行。" +
  "首 turn 检查单：① 第一个工具调用必须是 team_reconcile（readiness gate，失败即上行摘要）；② 确认 goal 已创建；③ 输出首轮摘要上行。";

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
        // 白名单防御（issue #103）：sessionId 进入文件系统寻址前校验，
        // 错误码对齐 overview 口径。
        if (!isValidSessionId(sessionId)) {
          writeJson(res, 400, { error: "invalid session parameter" });
          return;
        }
        // 视图供数解析：主会话直查优先；子会话按成员 durable id 反查所属
        // 实例（#97 问题 3），命中即以实例根身份应答并附归属信息。
        const view = resolveTeamHomeForView(sessionId);
        const l = layout(view.teamHome);
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
            ...(view.membership !== null ? { membership: view.membership } : {}),
          });
        } catch {
          writeJson(res, 200, {
            is_team: true,
            name: null,
            playbook_digest: null,
            ...(view.membership !== null ? { membership: view.membership } : {}),
          });
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
          // P0-2（#180）：create 端点 session 入路径前白名单早校验——此前仅查
          // 非空（`../../..` 可把实例根写出 sessions 目录建目录写文件），现对齐
          // status 端点 SESSION_PATTERN 口径。
          if (!isValidSessionId(body.session)) {
            writeJson(res, 400, { error: "invalid session parameter" });
            return;
          }
          // Wave 1b（#123）：拒绝已登记成员自建 root 提权——该会话已是某
          // 实例的成员（agents.json 反查命中）时，不允许再当主控建团。
          const existing = resolveTeamHomeForView(body.session);
          if (existing.membership !== null) {
            writeJson(res, 409, {
              error: {
                code: "member-conflict",
                message: `session is already a member (${existing.membership.member}) of ${existing.membership.root_session}; cannot create a new team`,
              },
            });
            return;
          }
          // handler 层负责 scenario 校验（unknown-scenario / ambiguous-scenario 稳定错误码）。
          const handlers = createHandlers(resolveTeamHome(body.session), body.session, rootCaller());
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
// 浏览器→dsh web 一跳超时兜底（ADR 0021）：半开连接下裸 fetch 会挂到 TCP
// 重传超时（可达 15 分钟）。AbortSignal.timeout 需 Safari 15.4+/iOS 15.4+；
// 更旧环境不注入（低频操作，依赖浏览器自身超时）。
const connTimeoutSignal = () =>
  typeof AbortSignal.timeout === "function" ? { signal: AbortSignal.timeout(10000) } : {};
async function jfetch(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
    ...connTimeoutSignal(),
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
