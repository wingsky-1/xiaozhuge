/**
 * 宿主装配层契约：cordis apply() 注册全部 team_* 工具；execute 按
 * HANDLER_BY_TOOL 路由到 handler 并包装 {ok, ...} 输出；卸载 disposer
 * 精确注销。schema 面做结构快照断言。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, name, inject } from "../../src/plugin/host.js";
import { schemas } from "../../src/plugin/schemas.js";
import { resolveTeamHome } from "../../src/team-home.js";
import { createHandlers } from "../../src/plugin/handlers.js";

interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
  output: { render: (args: unknown, value: unknown) => unknown };
  execute: (args: Record<string, unknown>, exec?: { agent?: { session?: { id?: string } } }) => Promise<unknown>;
}

function makeHost() {
  const registered = new Map<string, RegisteredTool>();
  const logs: string[] = [];
  const ctx = {
    tools: {
      register: (definition: unknown) => {
        const d = definition as RegisteredTool;
        registered.set(d.name, d);
        return () => registered.delete(d.name);
      },
    },
    logger: {
      info: (msg: string) => logs.push(msg),
      warn: (msg: string) => logs.push(msg),
    },
    get(key: string) {
      void key;
      return undefined;
    },
  };
  const dispose = apply(ctx);
  return { registered, logs, dispose };
}

// TEAM_HOME 指向临时目录，避免写真实 ~/.dsh
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "xzg-host-"));
  process.env.DSH_HOME = join(home, "dsh-home");
});

describe("插件装配", () => {
  it("插件名与注入声明", () => {
    expect(name).toBe("xiaozhuge-team");
    expect(inject).toEqual(["tools", "webServer"]);
  });

  it("注册 10 个 team_* 工具且命名规范（team_init 已下线，#51）", () => {
    const { registered } = makeHost();
    const names = [...registered.keys()].sort();
    expect(names).toEqual([
      "team_ack",
      "team_handoff",
      "team_inbox",
      "team_send",
      "team_spawn",
      "team_state_get",
      "team_state_set",
      "team_task_create",
      "team_task_list",
      "team_task_update",
    ]);
  });

  it("卸载 disposer 注销全部工具", () => {
    const { registered, dispose } = makeHost();
    expect(registered.size).toBe(10);
    dispose();
    expect(registered.size).toBe(0);
  });

  it("webServer 在场时注册 Console/入口路由并订阅页面注入（#51）", () => {
    const registered = new Map<string, unknown>();
    const routes: Array<{ path: string }> = [];
    let injectListener: ((table: unknown[]) => void) | undefined;
    const ctx = {
      tools: { register: (d: { name: string }) => {
        const disposer = () => registered.delete(d.name);
        registered.set(d.name, d);
        return disposer;
      } },
      webServer: { register: (route: { path: string }) => {
        routes.push(route);
        return () => {
          const i = routes.indexOf(route);
          if (i >= 0) routes.splice(i, 1);
        };
      } },
      logger: { info: () => {}, warn: () => {} },
      get: () => undefined,
      on: (event: "webserver/index-inject", listener: (table: unknown[]) => void) => {
        if (event === "webserver/index-inject") injectListener = listener;
      },
    };
    const dispose = apply(ctx as never);
    const paths = routes.map((r) => r.path);
    expect(paths).toContain("/xiaozhuge/console");
    expect(paths).toContain("/xiaozhuge/launch");
    expect(paths).toContain("/api/xiaozhuge/team/create");
    // 注入监听器被订阅且产出 script 行
    expect(typeof injectListener).toBe("function");
    const table: unknown[] = [];
    injectListener?.(table);
    expect(table).toHaveLength(1);
    dispose();
    expect(registered.size).toBe(0);
    expect(routes).toHaveLength(0);
  });

  it("TEAM_HOME 绑定到主会话 id（ADR 0005 宿主绑定层）", () => {
    expect(resolveTeamHome("session-abc")).toBe(
      join(process.env.DSH_HOME!, "xiaozhuge", "sessions", "session-abc"),
    );
  });
});

describe("execute 路由与输出包装", () => {
  it("team_spawn 经 execute 走到 handler 并包装 ok 输出", async () => {
    const { registered } = makeHost();
    const spawn = registered.get("team_spawn")!;
    const result = (await spawn.execute(
      { member: "qa", durable_id: "d-q", role: "qa", tier: 1 },
      { agent: { id: "session-h1" } },
    )) as {
      ok: boolean;
      member: string;
      durable_id: string;
    };
    expect(result.ok).toBe(true);
    expect(result.member).toBe("qa");
    // 渲染投影是 JSON 文本块
    const blocks = spawn.output.render({}, result) as Array<{ type: string; text: string }>;
    expect(blocks[0]?.type).toBe("text");
    expect(JSON.parse(blocks[0]!.text)).toMatchObject({ ok: true });
  });

  it("team_init 已下线（#51）：实例化走 HTTP 面而非 LLM 工具", () => {
    const { registered } = makeHost();
    expect(registered.get("team_init")).toBeUndefined();
  });

  it("参数缺失给 invalid-arguments（S1 结论：自行校验）", async () => {
    const { registered } = makeHost();
    await expect(
      registered.get("team_send")!.execute({ to: "x" }, { agent: { id: "s" } }),
    ).rejects.toMatchObject({ code: "invalid-arguments" });
  });

  it("spawn 后 send 可达（路由到同一实例根）", async () => {
    const { registered } = makeHost();
    const exec = { agent: { id: "session-route" } };
    // 实例化经 HTTP 面（#51）；此处直接驱动 handler 建团队态。
    await createHandlers(resolveTeamHome("session-route"), "session-route").init({});
    await registered.get("team_spawn")!.execute(
      { member: "qa", durable_id: "d-q", role: "qa", tier: 1 },
      exec,
    );
    const sent = (await registered
      .get("team_send")!
      .execute({ to: "qa", from: "master", type: "info", body: { n: 1 } }, exec)) as {
      envelope_id: string;
    };
    expect(sent.envelope_id).toBeTruthy();
    const inbox = (await registered
      .get("team_inbox")!
      .execute({ member: "qa" }, exec)) as { unread: unknown[] };
    expect(inbox.unread).toHaveLength(1);
  });
});

describe("schema 面", () => {
  it("每个工具 schema 有 object 参数与 required 数组", () => {
    for (const [tool, schema] of Object.entries(schemas)) {
      const params = schema.parameters as { type: string; required?: string[]; additionalProperties: boolean };
      expect(params.type, tool).toBe("object");
      expect(params.additionalProperties, tool).toBe(false);
      if (params.required !== undefined) {
        expect(Array.isArray(params.required), `${tool}.required`).toBe(true);
      }
    }
    // 关键必填项抽查
    expect((schemas.send.parameters as { required: string[] }).required).toEqual(["to", "from", "type", "body"]);
    expect((schemas.taskUpdate.parameters as { properties: { status: { enum: string[] } } }).properties.status.enum)
      .toEqual(["queued", "running", "blocked", "done", "cancelled"]);
    expect((schemas.stateSet.parameters as { properties: { status: { enum: string[] } } }).properties.status.enum)
      .toEqual(["running", "blocked", "done"]);
  });
});
