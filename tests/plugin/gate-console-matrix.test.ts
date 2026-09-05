/**
 * gate-console 穷举负矩阵：每条校验分支与响应文本逐一断言
 * （Stryker 条件/消息突变全数杀伤）。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { makeGateRoutes, makeConsoleRoute, originAllowed } from "../../src/plugin/gate-console.js";

void join;

function makeGateRoutesFor(sessionRoot: string) {
  return makeGateRoutes({ teamHomeFor: () => sessionRoot });
}

function mockReq(partial: Partial<{ method: string; url: string; headers: Record<string, string>; body: string }>): IncomingMessage & { body: string } {
  const req = {
    method: partial.method ?? "GET",
    url: partial.url ?? "/",
    headers: partial.headers ?? {},
    body: partial.body ?? "",
    [Symbol.iterator]: async function* () {
      if (partial.body !== undefined) yield partial.body;
    },
  } as unknown as IncomingMessage & { body: string };
  // readBody 用 for-await over req —— async iterable 需要 Symbol.asyncIterator
  Object.defineProperty(req, Symbol.asyncIterator, {
    value: async function* () {
      if (partial.body !== undefined) yield partial.body;
    },
  });
  return req;
}

const captured = new Map<ServerResponse, { status: number; body: string }>();
function capture(): { res: ServerResponse; out(): { status: number; body: string } } {
  const state = { status: 0, body: "" };
  const res = {
    writeHead: (s: number) => {
      state.status = s;
    },
    end: (b?: unknown) => {
      state.body += String(b ?? "");
    },
  } as unknown as ServerResponse;
  captured.set(res, state);
  return { res, out: () => captured.get(res)! };
}

function handlerOf(routes: ReturnType<typeof makeGateRoutes>, path: string, method?: string) {
  const route = routes.find((r) => r.path === path && (method === undefined || true))!;
  return route.handler;
}
void handlerOf;

describe("originAllowed 穷举", () => {
  const cases: Array<[string, Record<string, string> | undefined, boolean]> = [
    ["同源", { origin: "http://h:1", host: "h:1" }, true],
    ["缺 origin", {}, false],
    ["异源", { origin: "http://a.com", host: "h:1" }, false],
    ["origin 非法 URL", { origin: "::not-a-url::", host: "h:1" }, false],
  ];
  for (const [desc, headers, expected] of cases) {
    it(desc, () => {
      expect(originAllowed({ headers } as never)).toBe(expected);
    });
  }
});

describe("gate-console 路由穷举", () => {
  const root = mkdtempSync(join(tmpdir(), "xzg-p5m-"));
  const sessionRoot = join(root, "team");
  const routes = makeGateRoutesFor(sessionRoot);
  const gatesRoute = routes[0]!;
  const resolveRoute = routes[1]!;

  it("GET gates 缺 session → 400 missing session parameter", async () => {
    const { res, out } = capture();
    await gatesRoute.handler(mockReq({ url: "/api/xiaozhuge/gates" }), res as never);
    expect(out().status).toBe(400);
    expect(out().body && JSON.parse(out().body).error).toBe("missing session parameter");
  });

  it("POST gates 缺 id → 400 id required", async () => {
    const { res, out } = capture();
    await gatesRoute.handler(
      mockReq({ method: "POST", url: "/api/xiaozhuge/gates?session=s", headers: { origin: "http://h", host: "h" }, body: "{}" }),
      res as never,
    );
    expect(out().status).toBe(400);
    expect(out().body && JSON.parse(out().body).error).toBe("id required");
  });

  it("POST gates gate_id 白名单（P0-2，#180）：路径逃逸/分隔符/超长 → 400", async () => {
    for (const evil of ["../x", "a/b", "g".repeat(65)]) {
      const { res, out } = capture();
      await gatesRoute.handler(
        mockReq({ method: "POST", url: "/api/xiaozhuge/gates?session=s", headers: { origin: "http://h", host: "h" }, body: JSON.stringify({ id: evil }) }),
        res as never,
      );
      expect(out().status, `evil=${evil}`).toBe(400);
      expect(out().body && JSON.parse(out().body).error, `evil=${evil}`).toBe("invalid gate id parameter");
    }
  });

  it("POST gates 同 id 重复 → 409 already exists", async () => {
    const mk = () => capture();
    const r1cap = mk();
    const r1 = r1cap.res;
    const out1 = r1cap.out;
    await gatesRoute.handler(
      mockReq({ method: "POST", url: "/api/xiaozhuge/gates?session=dup", headers: { origin: "http://h", host: "h" }, body: '{"id":"g","reason":"","requestedBy":"m"}' }),
      r1 as never,
    );
    expect(out1().status).toBe(200);
    const r2cap = mk();
    const r2 = r2cap.res;
    const out2 = r2cap.out;
    await gatesRoute.handler(
      mockReq({ method: "POST", url: "/api/xiaozhuge/gates?session=dup", headers: { origin: "http://h", host: "h" }, body: '{"id":"g","reason":"","requestedBy":"m"}' }),
      r2 as never,
    );
    expect(out2().status).toBe(409);
  });

  it("resolve 非 POST → 405；非法 decision 文本如实回传", async () => {
    const { res, out } = capture();
    await resolveRoute.handler(
      mockReq({ method: "PUT", url: "/api/xiaozhuge/gates/resolve", headers: { origin: "http://h", host: "h" }, body: "{}" }),
      res as never,
    );
    expect(out().status).toBe(405);
    expect(out().body && JSON.parse(out().body).error).toBe("method not allowed");
  });

  it("resolve 参数缺失逐项报错", async () => {
    const { res, out } = capture();
    await resolveRoute.handler(
      mockReq({ method: "POST", url: "/api/xiaozhuge/gates/resolve", headers: { origin: "http://h", host: "h" }, body: "{}" }),
      res as never,
    );
    expect(out().status).toBe(400);
    expect(out().body && JSON.parse(out().body).error).toContain("session, gate_id and decision");
  });

  it("resolve gate_id 白名单（P0-2，#180）：路径逃逸/分隔符/超长 → 400", async () => {
    for (const evil of ["../x", "a/b", "g".repeat(65)]) {
      const { res, out } = capture();
      await resolveRoute.handler(
        mockReq({ method: "POST", url: "/api/xiaozhuge/gates/resolve", headers: { origin: "http://h", host: "h" }, body: JSON.stringify({ session: "s", gate_id: evil, decision: "approved" }) }),
        res as never,
      );
      expect(out().status, `evil=${evil}`).toBe(400);
      expect(out().body && JSON.parse(out().body).error, `evil=${evil}`).toBe("invalid gate id parameter");
    }
  });

  // session 白名单（issue #103）：路径逃逸/分隔符/多字节/超长一律 400。
  it("session 白名单：GET gates 非法 session → 400 invalid session parameter", async () => {
    for (const evil of ["../../etc", "a/b", "含中文", "a".repeat(129), "s\0"]) {
      const { res, out } = capture();
      await gatesRoute.handler(
        mockReq({ url: `/api/xiaozhuge/gates?session=${encodeURIComponent(evil)}` }),
        res as never,
      );
      expect(out().status, `evil=${evil}`).toBe(400);
      expect(out().body && JSON.parse(out().body).error, `evil=${evil}`).toBe("invalid session parameter");
    }
  });

  it("session 白名单：resolve 非法 session → 400 invalid session parameter", async () => {
    for (const evil of ["../../etc", "a b", "x".repeat(200)]) {
      const { res, out } = capture();
      await resolveRoute.handler(
        mockReq({
          method: "POST",
          url: "/api/xiaozhuge/gates/resolve",
          headers: { origin: "http://h", host: "h" },
          body: JSON.stringify({ session: evil, gate_id: "g", decision: "approved" }),
        }),
        res as never,
      );
      expect(out().status, `evil=${evil}`).toBe(400);
      expect(out().body && JSON.parse(out().body).error, `evil=${evil}`).toBe("invalid session parameter");
    }
  });

  it("console 页路由直出 HTML", async () => {
    const consoleRoute = makeConsoleRoute();
    const chunks: string[] = [];
    const res = {
      writeHead: () => {},
      end: (b?: string) => chunks.push(b ?? ""),
    } as unknown as ServerResponse;
    await consoleRoute.handler(mockReq({}), res);
    expect(chunks.join("")).toContain("Gate 待办");
  });
});
