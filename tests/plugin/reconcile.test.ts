/**
 * team_reconcile 对账原语单测（ADR 0015 决策 1，#66）。
 * 覆盖：overview 全量视图（成员对照 / 悬空指派 / 状态分布 / 事件游标 /
 * goal 占位）、scope=audit 旁路 report-only（未登记文件 / 过期登记 /
 * 敏感名掩码 / 无工作区不可用）、参数校验。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandlers, type Handlers } from "../../src/plugin/handlers.js";

let home: string;
let handlers: Handlers;
let workspace: string;
const SESSION = "session-reconcile-1";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "xzg-rec-home-"));
  workspace = mkdtempSync(join(tmpdir(), "xzg-rec-ws-"));
  handlers = createHandlers(home, SESSION);
});

describe("team_reconcile overview", () => {
  it("一次调用返回快照摘要、成员对照、状态分布、事件游标与 goal 占位", async () => {
    await handlers.init({ project_root: workspace });
    await handlers.spawn({ member: "coder", durable_id: "dur-coder", role: "coder", tier: 1 });
    const t = (await handlers.taskCreate({
      title: "实现 X",
      room: "root",
      assignee: "coder",
      touched_paths: ["src/a.ts"],
    })) as { task_id: string };
    // 悬空指派：账本有 assignee、注册表无此成员。
    await handlers.taskUpdate({ task_id: t.task_id, assignee: "ghost" });

    const view = (await handlers.reconcile({})) as {
      ok: boolean;
      scope: string;
      initialized: boolean;
      snapshot: { source: string | null; workspace_seen?: unknown };
      members: Array<{ member: string; liveness: string; assigned_task_ids: string[] }>;
      dangling_assignees: string[];
      task_status_counts: Record<string, number>;
      event_cursors: Array<{ room: string; seq: number }>;
      goal_binding: string;
      tool_manifest_pointer: string;
    };

    expect(view.ok).toBe(true);
    expect(view.scope).toBe("overview");
    expect(view.initialized).toBe(true);
    expect(view.snapshot?.source).toBe("builtin");
    expect(view.members).toHaveLength(1);
    expect(view.members[0]).toMatchObject({
      member: "coder",
      durable_id: "dur-coder",
      liveness: "framework-invisible",
    });
    expect(view.dangling_assignees).toEqual(["ghost"]);
    expect(view.task_status_counts).toEqual({ queued: 1 });
    expect(view.event_cursors[0]?.room).toBe("root");
    expect(view.event_cursors[0]!.seq).toBeGreaterThan(0);
    expect(view.goal_binding).toContain("framework-invisible");
    expect(view.goal_binding).toContain("get_goal");
    expect(view.tool_manifest_pointer).toContain("tool manifest");
  });

  it("未初始化实例返回 initialized=false 且不抛错", async () => {
    const view = (await handlers.reconcile({})) as { initialized: boolean; snapshot: unknown };
    expect(view.initialized).toBe(false);
    expect(view.snapshot).toBeNull();
  });
});

describe("team_reconcile scope=audit", () => {
  it("双向 diff：未登记文件命中、登记在案不误报、过期登记入 stale", async () => {
    // 工作树：src/a.ts（将登记）+ build.log（不登记）。
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "a.ts"), "export {};\n");
    writeFileSync(join(workspace, "build.log"), "noise\n");

    await handlers.init({ project_root: workspace });
    await handlers.taskCreate({
      title: "T",
      room: "root",
      touched_paths: ["src/a.ts", "gone/missing.ts"],
    });

    const view = (await handlers.reconcile({ scope: "audit" })) as {
      audit: {
        available: boolean;
        scanned_root: string;
        unregistered_files: Array<{ path: string; size: number; sensitive_masked: boolean }>;
        stale_registered_paths: string[];
        truncated: boolean;
      };
    };

    expect(view.audit.available).toBe(true);
    expect(view.audit.scanned_root).toBe(workspace);
    const paths = view.audit.unregistered_files.map((f) => f.path);
    expect(paths).toContain("build.log");
    expect(paths).not.toContain(join("src", "a.ts"));
    expect(view.audit.stale_registered_paths).toEqual(["gone/missing.ts"]);
    expect(view.audit.truncated).toBe(false);
    // 元数据形态：size/mtime 为数值，绝无内容字段。
    const f = view.audit.unregistered_files.find((x) => x.path === "build.log")!;
    expect(typeof f.size).toBe("number");
    expect(f.sensitive_masked).toBe(false);
    expect(Object.keys(f)).not.toContain("content");
  });

  it("敏感文件名打掩码，完整名不外泄", async () => {
    writeFileSync(join(workspace, ".env.local"), "SECRET=1\n");
    await handlers.init({ project_root: workspace });
    const view = (await handlers.reconcile({ scope: "audit" })) as {
      audit: { unregistered_files: Array<{ path: string; sensitive_masked: boolean }> };
    };
    const masked = view.audit.unregistered_files.find((f) => f.sensitive_masked);
    expect(masked).toBeDefined();
    expect(masked!.path).not.toContain(".env.local");
    expect(masked!.path.endsWith("<masked:sensitive-name>")).toBe(true);
  });

  it("旧快照无 workspace 字段 → 审计诚实标注不可用", async () => {
    await handlers.init({});
    const view = (await handlers.reconcile({ scope: "audit" })) as {
      audit: { available: boolean; reason: string };
    };
    expect(view.audit.available).toBe(false);
    expect(view.audit.reason).toContain("audit unavailable");
  });
});

describe("team_reconcile 参数校验", () => {
  it("非法 scope 拒绝", async () => {
    await handlers.init({});
    await expect(handlers.reconcile({ scope: "everything" })).rejects.toMatchObject({
      code: "invalid-arguments",
    });
  });
});
