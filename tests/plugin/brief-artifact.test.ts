/**
 * brief 工件化 + protocol_health 集成单测（#212，ADR 0024）。
 *
 * golden 矩阵（评审维度 8）：
 * - P0-1 落盘断言 ×3：init 后 brief 在场且与 user_prompt 逐字一致（水印外）/
 *   空输入写占位 / master 补写不被 init 重入覆盖；
 * - reconcile protocol_health 恒在场三态契约；
 * - no-delegation warning 首检落 deviation 留痕事件，repeat 不重复 append；
 * - audit rooms 污染派生标注：框架特征文件命中 / 业务 rooms/ 不误报。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandlers, rootCaller, type Handlers } from "../../src/plugin/handlers.js";
import { BRIEF_FRAMEWORK_MARKER, USER_OBJECTIVE_PLACEHOLDER, DEVIATION_EVENT } from "../../src/index.js";
import { EventLog } from "../../src/runtime/kernel/event-log.js";

let home: string;
let handlers: Handlers;
const SESSION = "session-issue212";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "xzg-brief-"));
  handlers = createHandlers(home, SESSION, rootCaller());
});

const briefPath = () => join(home, "rooms", "root", "brief", "user-request.md");

describe("P0-1 init brief 工件化", () => {
  it("user_prompt 非空：brief 在场且水印外与 user_prompt 逐字节一致", async () => {
    await handlers.init({ user_prompt: "准备新版本release note" });
    const text = readFileSync(briefPath(), "utf8");
    expect(text).toContain(BRIEF_FRAMEWORK_MARKER);
    expect(text).toContain("# User Objective (verbatim)");
    expect(text.endsWith("准备新版本release note\n")).toBe(true);
  });

  it("空输入写占位（与 activation 兜底占位同源）", async () => {
    await handlers.init({});
    const text = readFileSync(briefPath(), "utf8");
    expect(text).toContain(BRIEF_FRAMEWORK_MARKER);
    expect(text).toContain(USER_OBJECTIVE_PLACEHOLDER);
  });

  it("master 补写（无水印）不被同会话重入覆盖", async () => {
    await handlers.init({ user_prompt: "original" });
    writeFileSync(briefPath(), "master rewrote: takeover reconstruction", "utf8");
    await handlers.init({ user_prompt: "original" }); // 同会话重入（幂等分支）
    expect(readFileSync(briefPath(), "utf8")).toBe("master rewrote: takeover reconstruction");
  });

  it("team.yaml 快照带 brief_framework_written=true（存量实例无字段 → not-applicable）", async () => {
    await handlers.init({});
    const snap = JSON.parse(readFileSync(join(home, "team.yaml"), "utf8")) as {
      brief_framework_written?: boolean;
    };
    expect(snap.brief_framework_written).toBe(true);
  });
});

describe("protocol_health reconcile 契约", () => {
  it("恒在场、三态结构；新实例宽限窗内 delegation available", async () => {
    await handlers.init({});
    const view = (await handlers.reconcile({})) as {
      protocol_health: { items: Array<{ check: string; status: string }>; warnings: number };
    };
    const checks = view.protocol_health.items.map((i) => i.check);
    expect(checks).toEqual(["brief", "delegation", "blackboard-silent"]);
    expect(view.protocol_health.warnings).toBe(0);
    const delegation = view.protocol_health.items.find((i) => i.check === "delegation")!;
    expect(delegation.status).toBe("available"); // 宽限窗内
  });

  it("no-delegation：宽限窗外 warning 首检落留痕，repeat 不重复 append", async () => {
    // 正常 init(写 team.yaml/brief/init 事件),再直写事件文件把 init ts
    // 伪造到宽限窗外(避免真实 sleep;append 的 ts 固定取 Date.now())。
    await handlers.init({ user_prompt: "obj" });
    const eventFile = join(home, "rooms", "root", "events.jsonl");
    const log = new EventLog(eventFile);
    await log.init();
    const lines = readFileSync(eventFile, "utf8").split("\n").filter((l) => l !== "");
    const records = lines.map((l) => JSON.parse(l) as { seq: number; ts: number; [k: string]: unknown });
    records[0]!.ts = Date.now() - 60 * 60 * 1000; // 1 小时前 init
    writeFileSync(
      eventFile,
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );

    const v1 = (await handlers.reconcile({})) as {
      protocol_health: { items: Array<{ check: string; status: string; first_detected_seq?: number; repeat?: boolean }> };
    };
    const d1 = v1.protocol_health.items.find((i) => i.check === "delegation")!;
    expect(d1.status).toBe("warning");
    expect(d1.first_detected_seq).toBeGreaterThan(0);
    expect(d1.repeat).toBeUndefined();

    const v2 = (await handlers.reconcile({})) as {
      protocol_health: { items: Array<{ check: string; status: string; repeat?: boolean }> };
    };
    const d2 = v2.protocol_health.items.find((i) => i.check === "delegation")!;
    expect(d2.status).toBe("warning");
    expect(d2.repeat).toBe(true);
    expect(d2.detail).toContain("repeat (first detected at seq");

    // 留痕事件恰一条（幂等）。
    const { events } = await log.read(1);
    const deviations = events.filter((e) => e.type === DEVIATION_EVENT);
    expect(deviations).toHaveLength(1);
  });

  it("blackboard-silent：research-report 模板义务声明生效路径（义务角色完成零黑板 → warning）", async () => {
    // 使用独立 handlers（research-report 场景），走真实模板义务声明。
    const rrHome = mkdtempSync(join(tmpdir(), "xzg-brief-rr-"));
    const rr = createHandlers(rrHome, "session-rr", rootCaller());
    await rr.init({ scenario: "research-report" });
    await rr.spawn({
      member: "researcher-a1",
      durable_id: "dur-rr-1",
      role: "researcher",
      tier: 1,
      parent: "master",
    });
    const t = (await rr.taskCreate({
      title: "gather",
      room: "root",
      assignee: "researcher-a1",
    })) as { task_id: string };
    await rr.taskUpdate({ task_id: t.task_id, status: "running" });
    await rr.taskUpdate({ task_id: t.task_id, status: "done" });
    const view = (await rr.reconcile({})) as {
      protocol_health: { items: Array<{ check: string; status: string; detail: string }> };
    };
    const b = view.protocol_health.items.find((i) => i.check === "blackboard-silent")!;
    expect(b.status).toBe("warning");
    expect(b.detail).toContain("researcher-a1");

    // 反向：成员补写黑板分片后 available。
    await rr.stateSet({ room: "root", role: "researcher-a1", status: "done", ext: { note: "x" } });
    const view2 = (await rr.reconcile({})) as {
      protocol_health: { items: Array<{ check: string; status: string }> };
    };
    expect(view2.protocol_health.items.find((i) => i.check === "blackboard-silent")!.status).toBe(
      "available",
    );
  });
});

describe("audit rooms 污染派生标注", () => {
  it("框架特征文件（rooms/root/events.jsonl、rooms/root/brief/**）命中 → suspected", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "xzg-brief-ws-"));
    await handlers.init({ project_root: workspace });
    mkdirSync(join(workspace, "rooms", "root", "brief"), { recursive: true });
    writeFileSync(join(workspace, "rooms", "root", "events.jsonl"), "{}\n", "utf8");
    writeFileSync(join(workspace, "rooms", "root", "brief", "user-request.md"), "x", "utf8");
    const view = (await handlers.reconcile({ scope: "audit" })) as {
      audit: {
        rooms_pollution_suspected?: boolean;
        rooms_pollution_evidence?: string[];
      };
    };
    expect(view.audit.rooms_pollution_suspected).toBe(true);
    expect(view.audit.rooms_pollution_evidence).toHaveLength(2);
  });

  it("反向：业务 rooms/（无 root 运行时特征）不标污染", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "xzg-brief-ws2-"));
    await handlers.init({ project_root: workspace });
    mkdirSync(join(workspace, "rooms", "meeting-notes"), { recursive: true });
    writeFileSync(join(workspace, "rooms", "meeting-notes", "a.md"), "business", "utf8");
    const view = (await handlers.reconcile({ scope: "audit" })) as {
      audit: { rooms_pollution_suspected?: boolean; unregistered_files: Array<{ path: string }> };
    };
    // 未登记文件仍如实列出，但污染标注不出现。
    expect(view.audit.unregistered_files.some((f) => f.path.includes("meeting-notes"))).toBe(true);
    expect(view.audit.rooms_pollution_suspected).toBeUndefined();
  });

  it("实例根 brief 在场不干扰事件游标与房间枚举（目录协议兼容回归）", async () => {
    await handlers.init({ user_prompt: "obj" });
    const view = (await handlers.reconcile({})) as {
      event_cursors: Array<{ room: string; seq: number }>;
    };
    expect(view.event_cursors).toHaveLength(1);
    expect(view.event_cursors[0]!.room).toBe("root");
    expect(view.event_cursors[0]!.seq).toBeGreaterThan(0);
    expect(existsSync(briefPath())).toBe(true);
  });
});
