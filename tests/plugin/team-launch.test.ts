/**
 * Team 拉起入口 HTTP 面测试（#51）：scenarios 枚举、create 一键建团
 * （默认/指定场景、unknown-scenario 稳定错误码、双头断言）、status 探测、
 * 入口页直出。node:http 真实监听回环端口驱动 WebRoute。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import {
  bootMessage,
  launchPageHtml,
  makeLaunchRoutes,
} from "../../src/plugin/team-launch.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "xzg-launch-"));
  process.env.DSH_HOME = join(home, "dsh-home");
});

/** 构造一个可通过加载校验的最小场景模板（team.yaml + roles + prompts）。 */
function makeScenario(root: string, name: string): void {
  const dir = join(root, name);
  mkdirSync(join(dir, "roles"), { recursive: true });
  mkdirSync(join(dir, "prompts"), { recursive: true });
  writeFileSync(join(dir, "prompts", "master.md"), `# ${name} master\n`);
  writeFileSync(join(dir, "prompts", "worker.md"), `# ${name} worker\n`);
  writeFileSync(
    join(dir, "team.yaml"),
    JSON.stringify({
      name,
      version: 1,
      tiers: [
        { id: "master", prompt: "./prompts/master.md" },
        { id: "worker", prompt: "./prompts/worker.md" },
      ],
      roles: ["master", "worker", "qa"],
    }),
  );
  writeFileSync(
    join(dir, "roles", "master.role.yaml"),
    JSON.stringify({ id: "master", prompt: "./prompts/master.md", dod: ["d"] }),
  );
  writeFileSync(
    join(dir, "roles", "worker.role.yaml"),
    JSON.stringify({ id: "worker", prompt: "./prompts/worker.md", dod: ["d"] }),
  );
  writeFileSync(
    join(dir, "roles", "qa.role.yaml"),
    JSON.stringify({ id: "qa", prompt: "./prompts/worker.md", as_judge: true, dod: ["d"] }),
  );
}

/** user 层模板根（DSH_HOME 在 beforeEach 隔离）。 */
function userTplRoot(): string {
  return join(home, "dsh-home", "xiaozhuge", "templates");
}

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
  it("列出全部 builtin 场景（oss-maintenance + research-report）带 source 标记", async () => {
    const base = await listen();
    const r = await fetch(`${base}/api/xiaozhuge/team/scenarios`);
    const data = (await r.json()) as { scenarios: Array<{ name: string; source: string }> };
    expect(data.scenarios).toEqual([
      { name: "oss-maintenance", source: "builtin" },
      { name: "research-report", source: "builtin" },
    ]);
  });

  it("scenarios 端点接受 workspace 参数（包含 project 层）", async () => {
    const base = await listen();
    // 带 workspace 参数但无 project 模板 → 仍只有 builtin
    const r = await fetch(`${base}/api/xiaozhuge/team/scenarios?workspace=${encodeURIComponent(home)}`);
    const data = (await r.json()) as { scenarios: Array<{ name: string; source: string }> };
    const builtin = data.scenarios.filter((s) => s.source === "builtin").length;
    expect(builtin).toBeGreaterThan(0);
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

  it("user 层模板经 source=user 实例化，返回携带 source 标记", async () => {
    makeScenario(userTplRoot(), "my-scenario");
    const base = await listen();
    const { status, json } = await post(base, { session: "s-user", scenario: "my-scenario", source: "user" });
    expect(status).toBe(200);
    expect(json.source).toBe("user");
    expect(json.scenario).toBe("my-scenario");
  });

  it("user 层唯一场景（无同名）可不指定 source 正常命中", async () => {
    makeScenario(userTplRoot(), "unique-scenario");
    const base = await listen();
    const { status, json } = await post(base, { session: "s-unique", scenario: "unique-scenario" });
    expect(status).toBe(200);
    expect(json.source).toBe("user");
    expect(json.scenario).toBe("unique-scenario");
  });

  it("同名场景（user+project）未指定 source → ambiguous-scenario（HTTP 400）", async () => {
    makeScenario(userTplRoot(), "dup");
    const projectRoot = join(home, "project-repo");
    mkdirSync(join(projectRoot, ".xiaozhuge", "templates"), { recursive: true });
    makeScenario(join(projectRoot, ".xiaozhuge", "templates"), "dup");
    const base = await listen();
    const { status, json } = await post(base, {
      session: "s-amb",
      scenario: "dup",
      workspace: projectRoot,
    });
    expect(status).toBe(400);
    expect(json.error.code).toBe("ambiguous-scenario");
  });

  it("同名场景指定 source 消歧：project 层命中", async () => {
    makeScenario(userTplRoot(), "dup");
    const projectRoot = join(home, "project-repo2");
    mkdirSync(join(projectRoot, ".xiaozhuge", "templates"), { recursive: true });
    makeScenario(join(projectRoot, ".xiaozhuge", "templates"), "dup");
    const base = await listen();
    const { status, json } = await post(base, {
      session: "s-proj",
      scenario: "dup",
      source: "project",
      workspace: projectRoot,
    });
    expect(status).toBe(200);
    expect(json.source).toBe("project");
    expect(json.scenario).toBe("dup");
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

describe("客户端插件构建产物", () => {
  // 构建产物仅在 pnpm build 后存在；mutation 沙箱不构建（无 dist），条件跳过——
  // 契约校验由 gauntlet job 的 build + test 全流程兜底。
  const clientBundle = join(process.cwd(), "dist", "client.js");
  it.runIf(existsSync(clientBundle))(
    "dist/client.js 契约完整：load id=包名、apply/inject 装配、React 走 external",
    () => {
      const bundle = readFileSync(clientBundle, "utf8");
    // load id = 完整包名（浏览器端模块注册契约）
    expect(bundle).toContain('id: "@wingsky-1/dsh-xiaozhuge"');
    // 契约外壳：factory(require) 注入 external 依赖
    expect(bundle).toContain("__ModuleLoader__.load");
    expect(bundle).toContain("factory: function (require)");
    // 装配 apply/inject（esbuild cjs 经 __export 表装配到 module.exports）
    expect(bundle).toContain("module.exports = __toCommonJS(index_exports)");
    expect(bundle).toContain("apply: () => apply");
    expect(bundle).toContain("inject: () => inject");
    // React 等宿主注入依赖不打进 bundle（require 注入）
    expect(bundle).toContain('require("react")');
    expect(bundle).toContain('require("react/jsx-runtime")');
  });

  it("client 源码含官方 slots 注册（conversation.input.right）与首轮判定（blank）", () => {
    const src = readFileSync(join(process.cwd(), "src", "client", "index.tsx"), "utf8");
    expect(src).toContain('"conversation.input.right"');
    expect(src).toContain("session.blank");
    expect(src).toContain('"/api/xiaozhuge/team/create"');
    expect(src).toContain("/api/xiaozhuge/team/scenarios");
    // 官方 typed 客户端投递（IApiClient.sessions.prompt），非手写 fetch 信封
    expect(src).toContain("apiClient.sessions.prompt");
    expect(src).toContain("apiClient.sessions.list");
    // 不再依赖服务端 DOM 注入
    expect(src).not.toContain("MutationObserver");
  });

  it("服务端不再做 index-inject 页面注入", () => {
    const host = readFileSync(join(process.cwd(), "src", "plugin", "host.ts"), "utf8");
    expect(host).not.toContain("makeIndexInjections");
  });

  it("client 与服务端 BOOT_MESSAGE_HEAD 文案一致（bundle 隔离，须手动同步）", async () => {
    const serverHead = (await import("../../src/plugin/team-launch.js")).BOOT_MESSAGE_HEAD;
    const clientSrc = readFileSync(join(process.cwd(), "src", "client", "index.tsx"), "utf8");
    const m = clientSrc.match(/BOOT_MESSAGE_HEAD\s*=\s*"([^"]+)"\s*\+\s*\n\s*"([^"]+)"/);
    expect(m).not.toBeNull();
    expect(`${m![1]}${m![2]}`).toBe(serverHead);
  });
});
