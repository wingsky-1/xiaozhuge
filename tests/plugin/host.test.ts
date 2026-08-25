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

  it("注册 11 个 team_* 工具且命名规范", () => {
    const { registered } = makeHost();
    const names = [...registered.keys()].sort();
    expect(names).toEqual([
      "team_ack",
      "team_handoff",
      "team_inbox",
      "team_init",
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
    expect(registered.size).toBe(11);
    dispose();
    expect(registered.size).toBe(0);
  });

  it("TEAM_HOME 绑定到主会话 id（ADR 0005 宿主绑定层）", () => {
    expect(resolveTeamHome("session-abc")).toBe(
      join(process.env.DSH_HOME!, "xiaozhuge", "sessions", "session-abc"),
    );
  });
});

describe("execute 路由与输出包装", () => {
  it("team_init 经 execute 走到 handler 并包装 ok 输出", async () => {
    const { registered } = makeHost();
    const init = registered.get("team_init")!;
    const result = (await init.execute({}, { agent: { id: "session-h1" } })) as {
      ok: boolean;
      lock: string;
      tier0_prompt: string | null;
      playbook_digest?: string;
    };
    expect(result.ok).toBe(true);
    expect(["acquired", "reentered"]).toContain(result.lock);
    // #42 分层组装：返回值 = 规程全文 + 固定分隔符 + 场景段，附 playbook 审计摘要
    expect(typeof result.tier0_prompt).toBe("string");
    expect(result.tier0_prompt).toContain("巡场");
    expect(result.tier0_prompt).toContain("资源防护三项");
    expect(result.tier0_prompt).toContain("tier0 playbook / scenario prompt boundary");
    expect(result.tier0_prompt).toContain("一级主控场景编排");
    expect(result.playbook_digest).toMatch(/^[0-9a-f]{16}$/);
    // 渲染投影是 JSON 文本块
    const blocks = init.output.render({}, result) as Array<{ type: string; text: string }>;
    expect(blocks[0]?.type).toBe("text");
    expect(JSON.parse(blocks[0]!.text)).toMatchObject({ ok: true });
  });

  it("同会话复用同一实例根：init 重入 reentered", async () => {
    const { registered } = makeHost();
    await registered.get("team_init")!.execute({}, { agent: { id: "session-h2" } });
    const again = (await registered
      .get("team_init")!
      .execute({}, { agent: { id: "session-h2" } })) as { lock: string };
    expect(again.lock).toBe("reentered");
  });

  it("不同主会话各自独立实例根", async () => {
    const { registered } = makeHost();
    const a = (await registered
      .get("team_init")!
      .execute({}, { agent: { id: "session-a" } })) as { home: string };
    const b = (await registered
      .get("team_init")!
      .execute({}, { agent: { id: "session-b" } })) as { home: string };
    expect(a.home).not.toBe(b.home);
  });

  it("无 agent 上下文时回退占位会话不炸", async () => {
    const { registered } = makeHost();
    const r = (await registered.get("team_init")!.execute({})) as { ok: boolean };
    expect(r.ok).toBe(true);
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
    await registered.get("team_init")!.execute({}, exec);
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
