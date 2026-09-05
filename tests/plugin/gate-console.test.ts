/**
 * P5 Gate HTTP 面测试：Origin 安全最小集、resolve 单向落账与审计事件、
 * Console 页直出。用 node:http 真实监听回环端口驱动 WebRoute handler。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { fetchSiteAllowed, makeGateRoutes, makeConsoleRoute, originAllowed } from "../../src/plugin/gate-console.js";
import { EventLog } from "../../src/runtime/kernel/event-log.js";

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

describe("Fetch Metadata 断言（#2 P0）", () => {
  it("Sec-Fetch-Site 跨站拒绝", () => {
    expect(
      fetchSiteAllowed({ headers: { "sec-fetch-site": "cross-site" } } as never),
    ).toBe(false);
    expect(
      fetchSiteAllowed({ headers: { "sec-fetch-site": "same-site" } } as never),
    ).toBe(false);
  });
  it("same-origin 与缺失（老设备兼容负例放行）均放行", () => {
    expect(fetchSiteAllowed({ headers: { "sec-fetch-site": "same-origin" } } as never)).toBe(true);
    expect(fetchSiteAllowed({ headers: {} } as never)).toBe(true);
  });

  it("跨站 SFS 的 resolve POST 被拒且无副作用", async () => {
    baseUrl = await listen();
    await fetch(`${baseUrl}/api/xiaozhuge/gates?session=${SESSION}`, {
      method: "POST",
      headers: { origin: baseUrl, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ id: "g-sfs", reason: "", requestedBy: "m" }),
    });
    const denied = await fetch(`${baseUrl}/api/xiaozhuge/gates/resolve`, {
      method: "POST",
      headers: { origin: baseUrl, "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ session: SESSION, gate_id: "g-sfs", decision: "approved" }),
    });
    expect(denied.status).toBe(403);
    const list = (await (await fetch(`${baseUrl}/api/xiaozhuge/gates?session=${SESSION}`)).json()) as {
      gates: Array<{ status: string }>;
    };
    expect(list.gates[0]?.status).toBe("pending");
  });

  it("SFS 缺失（legacy）放行且审计记录 absent-legacy 标记与远端 IP", async () => {
    baseUrl = await listen();
    await fetch(`${baseUrl}/api/xiaozhuge/gates?session=${SESSION}`, {
      method: "POST",
      headers: { origin: baseUrl },
      body: JSON.stringify({ id: "g-legacy", reason: "", requestedBy: "m" }),
    });
    const ok = await fetch(`${baseUrl}/api/xiaozhuge/gates/resolve`, {
      method: "POST",
      headers: { origin: baseUrl }, // 无 SFS 头
      body: JSON.stringify({ session: SESSION, gate_id: "g-legacy", decision: "approved" }),
    });
    expect(ok.status).toBe(200);
    const log = new EventLog(join(home, "dsh-home", "xiaozhuge", "sessions", SESSION, "rooms", "root", "events.jsonl"));
    await log.init();
    const { events } = await log.read();
    const audit = events.find((e) => e.type === "gate/resolve")!;
    expect((audit.payload as { sec_fetch_site?: string }).sec_fetch_site).toBe("absent-legacy");
    expect((audit.payload as { remote_ip?: string | null }).remote_ip).toBeTruthy();
  });
});

describe("Console 加固（#2 P0）", () => {
  it("响应携带 nonce CSP，脚本带 nonce，无内联事件处理器", async () => {
    baseUrl = await listen();
    const r = await fetch(`${baseUrl}/xiaozhuge/console`);
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'nonce-[0-9a-f-]+'/);
    expect(csp).toContain("connect-src 'self'");
    const html = await r.text();
    expect(html).toMatch(/<script nonce="/);
    expect(html).not.toContain("onclick=");
    // XSS 转义函数在渲染路径上
    expect(html).toContain("esc(g.reason)");
    expect(html).toContain("esc(g.id)");
  });

  it("零门槛（#195 U0-b）：无手填输入框，加载即定位 instances；resolve 未定位前拒绝", async () => {
    baseUrl = await listen();
    const html = await (await fetch(`${baseUrl}/xiaozhuge/console`)).text();
    // 打开即调 instances 枚举面
    expect(html).toContain("/api/xiaozhuge/gates/instances");
    // 旧手填路径清除：无 session 输入框、无旧提示文案
    expect(html).not.toContain('id="session"');
    expect(html).not.toContain("填入主会话");
    // 未定位实例前 resolve 不发出（防误批空实例）
    expect(html).toContain("if (!currentSession) return; // 未定位实例前不做任何裁决");
    // ?session= 直达保留（团队 tab 内嵌兼容）
    expect(html).toContain('location.search).get("session")');
  });
});

describe("instances 枚举面（#195 U0-b）", () => {
  /** 造一个实例目录：team.yaml（mtime 可控）+ gates/*.json（pending 计数用）。 */
  function makeInstance(name: string, opts: { mtimeMs: number; pending: number; resolved?: number }): void {
    const teamHome = join(home, "dsh-home", "xiaozhuge", "sessions", name);
    const gatesDir = join(teamHome, "gates");
    mkdirSync(gatesDir, { recursive: true });
    writeFileSync(join(teamHome, "team.yaml"), "name: t\n");
    for (let i = 0; i < opts.pending; i++) {
      writeFileSync(
        join(gatesDir, `g-pending-${i}.json`),
        JSON.stringify({ id: `g-pending-${i}`, status: "pending", reason: "", requestedBy: "m", requestedAt: 0 }),
      );
    }
    for (let i = 0; i < (opts.resolved ?? 0); i++) {
      writeFileSync(
        join(gatesDir, `g-done-${i}.json`),
        JSON.stringify({ id: `g-done-${i}`, status: "approved", reason: "", requestedBy: "m", requestedAt: 0 }),
      );
    }
    utimesSync(join(teamHome, "team.yaml"), new Date(opts.mtimeMs), new Date(opts.mtimeMs));
  }

  it("按最近活跃降序返回，pendingCount 只计 pending（approved 不计）", async () => {
    baseUrl = await listen();
    makeInstance("aaaa-old-instance", { mtimeMs: 1_000_000, pending: 1, resolved: 2 });
    makeInstance("bbbb-new-instance", { mtimeMs: 2_000_000, pending: 2 });
    const data = (await (await fetch(`${baseUrl}/api/xiaozhuge/gates/instances`)).json()) as {
      instances: Array<{ session: string; pendingCount: number }>;
    };
    expect(data.instances).toHaveLength(2);
    expect(data.instances[0]?.session).toBe("bbbb-new-instance");
    expect(data.instances[0]?.pendingCount).toBe(2);
    expect(data.instances[1]?.session).toBe("aaaa-old-instance");
    expect(data.instances[1]?.pendingCount).toBe(1);
  });

  it("空 sessions 根 / 无 team.yaml 目录 / 非法目录名均不产出实例", async () => {
    baseUrl = await listen();
    // 非法 session id 目录名（白名单外字符）与缺 team.yaml 的合法名目录都跳过
    mkdirSync(join(home, "dsh-home", "xiaozhuge", "sessions", "bad$name"), { recursive: true });
    mkdirSync(join(home, "dsh-home", "xiaozhuge", "sessions", "no-yaml-session"), { recursive: true });
    const data = (await (await fetch(`${baseUrl}/api/xiaozhuge/gates/instances`)).json()) as {
      instances: unknown[];
    };
    expect(data.instances).toEqual([]);
  });

  it("无 sessions 根（从未建团）返回空数组而非错误", async () => {
    baseUrl = await listen();
    const data = (await (await fetch(`${baseUrl}/api/xiaozhuge/gates/instances`)).json()) as {
      instances: unknown[];
    };
    expect(data.instances).toEqual([]);
  });

  it("非 GET 方法 → 405", async () => {
    baseUrl = await listen();
    const r = await fetch(`${baseUrl}/api/xiaozhuge/gates/instances`, {
      method: "POST",
      headers: { origin: baseUrl },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(405);
  });
});

describe("open gate 端点双头断言（#2 P0）", () => {
  it("无 Origin 的放置被拒", async () => {
    baseUrl = await listen();
    const denied = await fetch(`${baseUrl}/api/xiaozhuge/gates?session=${SESSION}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "g", reason: "", requestedBy: "m" }),
    });
    expect(denied.status).toBe(403);
  });

  it("跨站 SFS 的放置被拒", async () => {
    baseUrl = await listen();
    const denied = await fetch(`${baseUrl}/api/xiaozhuge/gates?session=${SESSION}`, {
      method: "POST",
      headers: { origin: baseUrl, "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ id: "g", reason: "", requestedBy: "m" }),
    });
    expect(denied.status).toBe(403);
  });
});
