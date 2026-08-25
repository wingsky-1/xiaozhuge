/**
 * Team 拉起入口 HTTP 面测试（#51）：scenarios 枚举、create 一键建团
 * （默认/指定场景、unknown-scenario 稳定错误码、双头断言）、status 探测、
 * 入口页直出、注入行生成。node:http 真实监听回环端口驱动 WebRoute。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import {
  bootMessage,
  launchPageHtml,
  makeIndexInjections,
  makeLaunchRoutes,
} from "../../src/plugin/team-launch.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "xzg-launch-"));
  process.env.DSH_HOME = join(home, "dsh-home");
});

async function listen(): Promise<string> {
  const routes = makeLaunchRoutes();
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

function jsonHeaders(base: string): Record<string, string> {
  return { "content-type": "application/json", origin: base };
}

async function post(
  base: string,
  body: unknown,
  headers: Record<string, string> = jsonHeaders(base),
): Promise<{ status: number; json: any }> {
  const r = await fetch(`${base}/api/xiaozhuge/team/create`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

describe("场景枚举", () => {
  it("列出全部 builtin 场景（oss-maintenance + research-report）", async () => {
    const base = await listen();
    const r = await fetch(`${base}/api/xiaozhuge/team/scenarios`);
    const data = (await r.json()) as { scenarios: string[] };
    expect(data.scenarios).toEqual(["oss-maintenance", "research-report"]);
  });
});

describe("team/create 一键建团", () => {
  it("默认场景：init 持久化 + tier0_prompt 组装 + 快照落盘", async () => {
    const base = await listen();
    const { status, json } = await post(base, { session: "s-default" });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.scenario).toBe("oss-maintenance");
    expect(json.tier0_prompt).toContain("资源防护三项");
    expect(json.tier0_prompt).toContain("tier0 playbook / scenario prompt boundary");
    expect(json.tier0_prompt).toContain("一级主控场景编排");
    expect(json.playbook_digest).toMatch(/^[0-9a-f]{16}$/);
    // 实例根持久化
    const snap = JSON.parse(
      await readFile(join(home, "dsh-home", "xiaozhuge", "sessions", "s-default", "team.yaml"), "utf8"),
    ) as { name: string; playbook_digest?: string };
    expect(snap.name).toBe("oss-maintenance");
    expect(snap.playbook_digest).toBe(json.playbook_digest);
  });

  it("research-report 场景：实例化后 tier0_prompt 含规程全文（#39 依赖）", async () => {
    const base = await listen();
    const { status, json } = await post(base, { session: "s-rr", scenario: "research-report" });
    expect(status).toBe(200);
    expect(json.scenario).toBe("research-report");
    expect(json.tier0_prompt).toContain("Tier-0 巡场规程");
    expect(json.tier0_prompt).toContain("唯一主控");
  });

  it("未知场景给稳定错误码 unknown-scenario（HTTP 400）", async () => {
    const base = await listen();
    for (const bad of ["no-such-template", "../escape", "OSS"]) {
      const { status, json } = await post(base, { session: "s-bad", scenario: bad });
      expect(status, bad).toBe(400);
      expect((json.error as { code: string }).code, bad).toBe("unknown-scenario");
    }
  });

  it("缺 session 参数 400；无 Origin POST 403；SFS 跨站 403", async () => {
    const base = await listen();
    const noSession = await post(base, {});
    expect(noSession.status).toBe(400);
    const noOrigin = await post(base, { session: "s" }, { "content-type": "application/json" });
    expect(noOrigin.status).toBe(403);
    const crossSite = await post(
      base,
      { session: "s" },
      { ...jsonHeaders(base), "sec-fetch-site": "cross-site" },
    );
    expect(crossSite.status).toBe(403);
  });

  it("同会话重入 reentered（幂等不变），异会话独立实例根", async () => {
    const base = await listen();
    const first = await post(base, { session: "s-re" });
    expect(first.json.lock).toBe("acquired");
    const again = await post(base, { session: "s-re" });
    expect(again.json.lock).toBe("reentered");
    const other = await post(base, { session: "s-other" });
    expect(other.json.home).not.toBe(first.json.home);
  });
});

describe("team/status 团队会话探测", () => {
  it("未初始化 is_team=false；建团后 true 并带 name/digest", async () => {
    const base = await listen();
    const before = await (await fetch(`${base}/api/xiaozhuge/team/status?session=s-st`)).json();
    expect(before.is_team).toBe(false);
    await post(base, { session: "s-st", scenario: "research-report" });
    const after = (await (
      await fetch(`${base}/api/xiaozhuge/team/status?session=s-st`)
    ).json()) as { is_team: boolean; name?: string };
    expect(after.is_team).toBe(true);
    expect(after.name).toBe("research-report");
  });

  it("缺 session 参数 400", async () => {
    const base = await listen();
    const r = await fetch(`${base}/api/xiaozhuge/team/status`);
    expect(r.status).toBe(400);
  });
});

describe("入口页与启动消息", () => {
  it("GET 直出 HTML：一键按钮与四步编排脚本在场", async () => {
    const base = await listen();
    const r = await fetch(`${base}/xiaozhuge/launch`);
    const html = await r.text();
    expect(html).toContain("一键建团并投递规程");
    expect(html).toContain("/api/xiaozhuge/team/scenarios");
    expect(html).toContain("/api/session.create");
    expect(html).toContain("/api/xiaozhuge/team/create");
    expect(html).toContain("/api/session.prompt");
  });

  it("launchPageHtml 与 bootMessage 前缀一致且含规程占位", () => {
    const html = launchPageHtml();
    const head = JSON.parse(
      (html.match(/const BOOT_HEAD = (.+);/) ?? [])[1] ?? '""',
    ) as string;
    expect(head).toBeTruthy();
    expect(bootMessage("PROBE")).toContain(head);
    expect(bootMessage("PROBE").endsWith("PROBE")).toBe(true);
  });
});

describe("宿主页面注入行", () => {
  it("单个 script 行（body 位），含浮动入口与团队 tab 逻辑", () => {
    const rows = makeIndexInjections();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("script");
    expect(rows[0]?.placement).toBe("body");
    expect(rows[0]?.text).toContain("/xiaozhuge/launch");
    expect(rows[0]?.text).toContain("injectTeamTab");
  });
});
