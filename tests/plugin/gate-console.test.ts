/**
 * P5 Gate HTTP 面测试：Origin 安全最小集、resolve 单向落账与审计事件、
 * Console 页直出。用 node:http 真实监听回环端口驱动 WebRoute handler。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { makeGateRoutes, makeConsoleRoute, originAllowed } from "../../src/plugin/gate-console.js";
import { EventLog } from "../../src/runtime/event-log.js";

const SESSION = "session-gate-test";
let home: string;
let baseUrl: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "xzg-p5-"));
  process.env.DSH_HOME = join(home, "dsh-home");
});

async function listen(): Promise<string> {
  const routes = [
    ...makeGateRoutes({ teamHomeFor: (s) => join(home, "dsh-home", "xiaozhuge", "sessions", s) }),
    makeConsoleRoute(),
  ];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    for (const route of routes) {
      if (route.kind === "exact" && route.path === url.pathname) {
        void route.handler(req, res);
        return;
      }
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function request(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = import("node:http").then(({ request: httpRequest }) => {
      const u = new URL(path, base);
      const r = httpRequest(
        u,
        { method, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) } },
        (res) => {
          let raw = "";
          res.on("data", (c) => (raw += String(c)));
          res.on("end", () => {
            try {
              resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw) });
            } catch {
              resolve({ status: res.statusCode ?? 0, json: raw });
            }
          });
        },
      );
      r.on("error", reject);
      if (body !== undefined) r.write(JSON.stringify(body));
      r.end();
    });
    void req;
  });
}

describe("Origin 安全最小集", () => {
  it("同源放行", () => {
    expect(originAllowed({ headers: { origin: "http://127.0.0.1:3080", host: "127.0.0.1:3080" } } as never)).toBe(true);
  });
  it("缺失 Origin 拒绝（非浏览器客户端）", () => {
    expect(originAllowed({ headers: {} } as never)).toBe(false);
  });
  it("异源 Origin 拒绝", () => {
    expect(originAllowed({ headers: { origin: "http://evil.example", host: "127.0.0.1:3080" } } as never)).toBe(false);
  });
});

describe("gate resolve 端点", () => {
  it("无 Origin 的 POST 被拒（agent bash/curl 场景）并留审计外无副作用", async () => {
    baseUrl = await listen();
    // 先经合法通道开 gate
    await fetch(`${baseUrl}/api/xiaozhuge/gates?session=${SESSION}`, {
      method: "POST",
      headers: { origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ id: "plan-approval", reason: "计划待批", requestedBy: "master" }),
    });
    const denied = await fetch(`${baseUrl}/api/xiaozhuge/gates/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" }, // 无 Origin
      body: JSON.stringify({ session: SESSION, gate_id: "plan-approval", decision: "approved" }),
    });
    expect(denied.status).toBe(403);
    const list = await (await fetch(`${baseUrl}/api/xiaozhuge/gates?session=${SESSION}`)).json();
    expect(list.gates[0]?.status).toBe("pending");
  });

  it("浏览器同源批准：状态翻转 approved 且审计事件入库", async () => {
    baseUrl = await listen();
    await fetch(`${baseUrl}/api/xiaozhuge/gates?session=${SESSION}`, {
      method: "POST",
      headers: { origin: baseUrl },
      body: JSON.stringify({ id: "plan-approval", reason: "计划待批", requestedBy: "master" }),
    });
    const ok = await fetch(`${baseUrl}/api/xiaozhuge/gates/resolve`, {
      method: "POST",
      headers: { origin: baseUrl },
      body: JSON.stringify({ session: SESSION, gate_id: "plan-approval", decision: "approved", by: "human-web" }),
    });
    expect(ok.status).toBe(200);

    // 文件翻转
    const list = (await (await fetch(`${baseUrl}/api/xiaozhuge/gates?session=${SESSION}`)).json()) as {
      gates: Array<{ id: string; status: string; resolvedBy?: string }>;
    };
    expect(list.gates[0]?.status).toBe("approved");
    expect(list.gates[0]?.resolvedBy).toBe("human-web");

    // 审计事件（who/when/gate id/UA 指纹/结果）
    const log = new EventLog(join(home, "dsh-home", "xiaozhuge", "sessions", SESSION, "rooms", "root", "events.jsonl"));
    await log.init();
    const { events } = await log.read();
    const audit = events.find((e) => e.type === "gate/resolve");
    expect(audit).toBeDefined();
    const payload = audit!.payload as { gate_id: string; decision: string; ua_fingerprint: string };
    expect(payload.gate_id).toBe("plan-approval");
    expect(payload.decision).toBe("approved");
    expect(payload.ua_fingerprint).toMatch(/^len\d+:/);
  });

  it("重复裁决被拒（pending → resolved 单向）", async () => {
    baseUrl = await listen();
    const headers = { origin: baseUrl };
    await fetch(`${baseUrl}/api/xiaozhuge/gates?session=${SESSION}`, {
      method: "POST", headers,
      body: JSON.stringify({ id: "g", reason: "", requestedBy: "m" }),
    });
    await fetch(`${baseUrl}/api/xiaozhuge/gates/resolve`, {
      method: "POST", headers,
      body: JSON.stringify({ session: SESSION, gate_id: "g", decision: "denied" }),
    });
    const second = await fetch(`${baseUrl}/api/xiaozhuge/gates/resolve`, {
      method: "POST", headers,
      body: JSON.stringify({ session: SESSION, gate_id: "g", decision: "approved" }),
    });
    expect(second.status).toBe(409);
  });

  it("非法 decision / 缺参数 400", async () => {
    baseUrl = await listen();
    const noDecision = await fetch(`${baseUrl}/api/xiaozhuge/gates/resolve`, {
      method: "POST",
      headers: { origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ session: SESSION, gate_id: "x" }),
    });
    expect(noDecision.status).toBe(400);
    const badDecision = await fetch(`${baseUrl}/api/xiaozhuge/gates/resolve`, {
      method: "POST",
      headers: { origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ session: SESSION, gate_id: "x", decision: "maybe" }),
    });
    expect(badDecision.status).toBe(400);
  });

  it("GET 列表缺 session 参数 400", async () => {
    baseUrl = await listen();
    const r = await fetch(`${baseUrl}/api/xiaozhuge/gates`);
    expect(r.status).toBe(400);
  });
});

describe("Console 页面", () => {
  it("GET 直出 HTML，含待办渲染脚本与 API 地址", async () => {
    baseUrl = await listen();
    const r = await fetch(`${baseUrl}/xiaozhuge/console`);
    const html = await r.text();
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("/api/xiaozhuge/gates");
    expect(html).toContain("Gate 待办");
    expect(html).toContain("prefers-color-scheme"); // 双主题
    expect(html).toContain('name="viewport"'); // 375px 视口适配
  });
});
