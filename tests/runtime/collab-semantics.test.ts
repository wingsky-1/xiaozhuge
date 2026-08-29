import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acknowledge,
  claim,
  deliver,
  DELIVERY_WAKEUP_MATRIX,
  discardRunningSentinels,
  harvestMailbox,
  listShards,
  MAILBOX_SEGMENTS,
  readUnread,
  recoverDeliveries,
  setShard,
  getShard,
  RuntimeError,
  validateRoleSet,
  validateRoleSpec,
  validateTeamTemplate,
  GATE_FLOW,
  TEMPLATE_SOURCES,
} from "../../src/index.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "xzg-p2b-"));
}

describe("信箱三段式", () => {
  it("deliver → claim → ack 全链路", async () => {
    const home = tmpHome();
    const id = await deliver(home, "coder", { from: "master", type: "task-assign", body: { taskId: "t1" } });
    let unread = await readUnread(home, "coder");
    expect(unread).toHaveLength(1);
    expect(unread[0]?.id).toBe(id);
    expect(unread[0]?.body).toEqual({ taskId: "t1" });

    const env = await claim(home, "coder", id);
    expect(env.type).toBe("task-assign");
    // claim 后待读位清空
    expect(await readUnread(home, "coder")).toHaveLength(0);
    expect(existsSync(join(home, "mailbox", "coder", `.delivering-${id}.json`))).toBe(true);

    await acknowledge(home, "coder", id);
    expect(existsSync(join(home, "mailbox", "coder", `processed/${id}.json`))).toBe(true);
    expect(existsSync(join(home, "mailbox", "coder", `.delivering-${id}.json`))).toBe(false);
  });

  it("double-inject 拒绝：同 uuid 二次发布被 link 挡下", async () => {
    const home = tmpHome();
    const home2 = tmpHome();
    await deliver(home2, "qa", { from: "m", type: "t", body: null }, { id: "fixed-uuid" });
    // 同 uuid 二次发布必拒（double-inject 防线）
    await expect(
      deliver(home2, "qa", { from: "m", type: "t", body: null }, { id: "fixed-uuid" }),
    ).rejects.toThrow(/double-inject/);
  });

  it("claim 冲突拒绝（已被认领）与 unknown uuid 报错", async () => {
    const home = tmpHome();
    const id = await deliver(home, "qa", { from: "m", type: "t", body: null });
    await claim(home, "qa", id);
    await expect(claim(home, "qa", id)).rejects.toThrow(/already claimed|unknown envelope/);
    await expect(claim(home, "qa", "nope")).rejects.toThrow();
  });

  it("重复 ack 幂等；harvest 清 processed 命中的残片并衔接 TTL 收割", async () => {
    const home = tmpHome();
    const id = await deliver(home, "qa", { from: "m", type: "t", body: null });
    await claim(home, "qa", id);
    await acknowledge(home, "qa", id);
    // 再 ack：无在途残片，静默成功
    await acknowledge(home, "qa", id);
    // 模拟「ack 中途崩溃」变体：processed 已有、delivering 又出现（异常残留）
    writeFileSync(join(home, "mailbox", "qa", `.delivering-${id}.json`), "{}");
    const swept = await harvestMailbox(home, "qa");
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(home, "mailbox", "qa", `.delivering-${id}.json`))).toBe(false);
  });

  it("收割回待读位 = at-least-once 重投（TTL 内不重复、超时后可重claim）", async () => {
    const home = tmpHome();
    const id = await deliver(home, "qa", { from: "m", type: "t", body: "job" });
    await claim(home, "qa", id);
    // 消费者僵死：手工把 delivering mtime 置为过去
    const fsp = await import("node:fs/promises");
    const dFile = join(home, "mailbox", "qa", `.delivering-${id}.json`);
    const past = new Date(Date.now() - 60_000);
    await fsp.utimes(dFile, past, past);
    const n = await harvestMailbox(home, "qa", 30_000);
    expect(n).toBe(1);
    // 回到待读位，可再次 claim（重投）
    const unread = await readUnread(home, "qa");
    expect(unread.map((e) => e.id)).toContain(id);
  });
});

describe("黑板分片", () => {
  it("set/get/list 与保留态强制", async () => {
    const home = tmpHome();
    await setShard(home, "root", "coder", { status: "running", ext: { task: "t1" } });
    await setShard(home, "root", "qa", { status: "blocked" });
    const shards = await listShards(home, "root");
    expect(shards.map((s) => s.role)).toEqual(["coder", "qa"]);
    expect((await getShard(home, "root", "coder"))?.ext).toEqual({ task: "t1" });
    await expect(setShard(home, "root", "x", { status: "review" })).rejects.toMatchObject({
      code: "invalid-stage",
    });
  });

  it("分片隔离：跨 role 文件互不可见", async () => {
    const home = tmpHome();
    await setShard(home, "r1", "a", { status: "done" });
    await setShard(home, "r2", "a", { status: "running" });
    expect((await getShard(home, "r1", "a"))?.status).toBe("done");
    expect((await getShard(home, "r2", "a"))?.status).toBe("running");
  });

  it("哨兵恢复与黑板联动：作废后分片消失", async () => {
    const home = tmpHome();
    await setShard(home, "root", "coder", { status: "running" });
    const stateDir = join(home, "rooms", "root", "state");
    const recovered = await discardRunningSentinels(stateDir);
    expect(recovered).toEqual([{ role: "coder", action: "discarded" }]);
    expect(await getShard(home, "root", "coder")).toBeUndefined();
  });

  it("多实例同 role 分片互不覆盖（Q5，#159）：member 名带实例后缀各自独立文件", async () => {
    const home = tmpHome();
    await setShard(home, "root", "coder-a1b2c3", { status: "running", ext: { inst: "a" } });
    await setShard(home, "root", "coder-d4e5f6", { status: "blocked", ext: { inst: "b" } });
    // 互不覆盖：各自读回自己的分片。
    expect((await getShard(home, "root", "coder-a1b2c3"))?.status).toBe("running");
    expect((await getShard(home, "root", "coder-a1b2c3"))?.ext).toEqual({ inst: "a" });
    expect((await getShard(home, "root", "coder-d4e5f6"))?.status).toBe("blocked");
    // listShards 双分片俱在。
    const shards = await listShards(home, "root");
    expect(shards.map((s) => s.role).sort()).toEqual(["coder-a1b2c3", "coder-d4e5f6"]);
  });

  it("旧分片天然兼容（Q5，#159）：纯 role 名分片可读、listShards 原样返回", async () => {
    const home = tmpHome();
    await setShard(home, "root", "legacy", { status: "running" });
    // 存量会话 member 名 = 纯 role 名时，<member>.json 与旧路径 <role>.json 同名，
    // 天然兼容（无后缀剥离回退——评审否决）。
    expect((await getShard(home, "root", "legacy"))?.status).toBe("running");
    const shards = await listShards(home, "root");
    expect(shards.map((s) => s.role)).toEqual(["legacy"]);
  });

  it("member 分片键白名单（Q5，#159 评审 P2-5）：非法键拒绝，防路径注入", async () => {
    const home = tmpHome();
    await expect(setShard(home, "root", "../escape", { status: "running" })).rejects.toMatchObject({
      code: "invalid-shard-key",
    });
    await expect(setShard(home, "root", "a/b", { status: "running" })).rejects.toMatchObject({
      code: "invalid-shard-key",
    });
    await expect(getShard(home, "root", "../escape")).rejects.toMatchObject({
      code: "invalid-shard-key",
    });
  });
});

describe("Team Template 校验", () => {
  const validRoles = [
    { id: "master", prompt: "./prompts/master.md" },
    { id: "spec-writer", prompt: "./p.md", dod: ["产出规格"] },
    { id: "coder", prompt: "./p.md", dod: ["build 绿"] },
    { id: "qa", prompt: "./p.md", as_judge: true, dod: ["逐条回执"] },
  ];
  const validTemplate = {
    name: "oss-maintenance",
    version: 2,
    tiers: [
      { id: "master", prompt: "./prompts/master.md" },
      { id: "issue-master", prompt: "./prompts/issue-master.md" },
    ],
    roles: ["master", "spec-writer", { ref: "coder" }, "qa"],
    comm_mode: "auto",
    archives: [
      { id: "tracking", type: "url", url: "https://example.com" },
      { id: "run-log", type: "file", target: "archive/run-1.md" },
    ],
    gates: [{ id: "plan-approval", at: "master", on: "stage-enter:queued" }],
    resources: { max_tiers: 3, max_active_rooms: 3, task_max_rounds: 3 },
    stages_ext: ["deciding", "building"],
    source: "builtin",
  };

  it("正例通过且一次收集全部错误", () => {
    const result = validateTeamTemplate(validTemplate);
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("负例：多规则并发报错不短路（code/path/message 全量快照）", () => {
    const bad = {
      name: "",
      version: 0,
      // 4 层触发上限（下限已放宽至 1，见 ADR 0008）；首层空 prompt 仍触发必填
      tiers: [
        { id: "t0", prompt: "" },
        { id: "t1", prompt: "p" },
        { id: "t2", prompt: "p" },
        { id: "t3", prompt: "p" },
      ],
      roles: [],
      comm_mode: "weird",
      archives: [{ id: "a", target: "../escape" }, { id: "u", type: "url" }],
      gates: [{ id: "g", at: "no-such-tier" }],
      resources: { max_tiers: -1 },
      stages_ext: ["running"],
      source: "alien",
    };
    const result = validateTeamTemplate(bad);
    const byCode = (code: string) => result.errors.filter((e) => e.code === code).map((e) => ({ path: e.path, message: e.message }));
    // 逐码断言 path 与 message 原文（StringLiteral/路径拼接突变全数杀伤）
    expect(byCode("name-required")).toEqual([{ path: "name", message: "template name is required" }]);
    expect(byCode("version-invalid")).toHaveLength(1);
    expect(byCode("tiers-length")).toEqual([{ path: "tiers", message: "template requires 1 to 3 tiers" }]);
    expect(byCode("tier-prompt-required")).toEqual([
      { path: "tiers[0].prompt", message: "tier prompt is required" },
    ]);
    expect(byCode("roles-required")).toEqual([
      { path: "roles", message: "at least one role is required" },
    ]);
    expect(byCode("comm-mode-invalid")).toEqual([
      { path: "comm_mode", message: "comm_mode must be auto or explicit" },
    ]);
    expect(byCode("archive-type-invalid").map((e) => e.path)).toEqual(["archives[0].type"]);
    expect(byCode("archive-target-escapes")).toEqual([]);
    expect(byCode("gate-at-unknown")[0]?.message).toBe("gate at references unknown tier: no-such-tier");
    expect(byCode("resource-invalid")).toEqual([
      { path: "resources.max_tiers", message: "resource limits must be positive integers" },
    ]);
    expect(byCode("stage-reserved")).toEqual([
      { path: "stages_ext", message: "stage conflicts with reserved: running" },
    ]);
    expect(byCode("source-invalid")).toEqual([
      { path: "source", message: "source must be one of builtin|user|project" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("file 型 archive 缺 target / url 型缺 url / target 越界各自报错", () => {
    const result = validateTeamTemplate({
      ...validTemplate,
      archives: [
        { id: "f1", type: "file" },
        { id: "u1", type: "url" },
        { id: "f2", type: "file", target: "/abs/path" },
        { id: "f3", type: "file", target: "a/../b" },
      ],
    });
    const codes = result.errors.map((e) => e.code);
    for (const code of ["archive-target-required", "archive-url-required", "archive-target-escapes"]) {
      expect(codes).toContain(code);
    }
  });

  it("tier 重复 id / gate at 引用不存在 tier", () => {
    const result = validateTeamTemplate({
      ...validTemplate,
      tiers: [
        { id: "same", prompt: "./a.md" },
        { id: "same", prompt: "./b.md" },
      ],
    });
    expect(result.errors.map((e) => e.code)).toContain("tier-duplicate");
  });

  it("explicit comm 缺白名单即拒；白名单边缺字段即拒", () => {
    expect(validateTeamTemplate({ ...validTemplate, comm_mode: "explicit" }).errors.map((e) => e.code))
      .toContain("explicit-comm-required");
    expect(
      validateTeamTemplate({ ...validTemplate, comm_mode: "explicit", comm: [{ from: "master" }] })
        .errors.map((e) => e.code),
    ).toContain("comm-edge-invalid");
  });

  it("来源标记合法枚举", () => {
    expect(TEMPLATE_SOURCES).toEqual(["builtin", "user", "project"]);
  });
});

describe("Role Spec 校验", () => {
  it("合法 spec（dod 路径）", () => {
    const r = validateRoleSpec({ id: "coder", prompt: "./p.md", dod: ["build 绿"] });
    expect(r.ok).toBe(true);
  });

  it("acceptance 小节路径等价满足", () => {
    const r = validateRoleSpec({
      id: "coder",
      prompt: "./p.md",
      briefing: { format: "structured", sections_required: ["background", "acceptance"] },
    });
    expect(r.ok).toBe(true);
  });

  it("dod 与 acceptance 双缺即拒", () => {
    const r = validateRoleSpec({ id: "x", prompt: "./p.md", dod: [] });
    expect(r.errors.map((e) => e.code)).toContain("dod-or-acceptance-required");
  });

  it("sections_required 枚举外的值拒绝", () => {
    const r = validateRoleSpec({
      id: "x",
      prompt: "./p.md",
      briefing: { format: "structured", sections_required: ["poetry"] },
    });
    expect(r.errors.map((e) => e.code)).toContain("section-unknown");
  });

  it("max_hops 非正整数 / as_judge 非布尔拒绝", () => {
    expect(validateRoleSpec({ id: "x", prompt: "./p.md", max_hops: 0 }).errors.map((e) => e.code))
      .toContain("max-hops-invalid");
    expect(validateRoleSpec({ id: "x", prompt: "./p.md", as_judge: "yes" }).errors.map((e) => e.code))
      .toContain("as-judge-not-bool");
  });

  it("角色集：as_judge 恰好一个（缺失/多判都拒）", () => {
    const noJudge = validateRoleSet([
      { id: "a", prompt: "./p", dod: ["d"] },
      { id: "b", prompt: "./p", dod: ["d"] },
    ]);
    expect(noJudge.errors.map((e) => e.code)).toContain("judge-count");
    const twoJudges = validateRoleSet([
      { id: "a", prompt: "./p", as_judge: true, dod: ["d"] },
      { id: "b", prompt: "./p", as_judge: true, dod: ["d"] },
    ]);
    expect(twoJudges.errors.map((e) => e.code)).toContain("judge-count");
    const oneJudge = validateRoleSet([
      { id: "a", prompt: "./p", as_judge: true, dod: ["d"] },
      { id: "b", prompt: "./p", dod: ["d"] },
    ]);
    expect(oneJudge.ok).toBe(true);
  });
});

describe("协议常量", () => {
  it("配对矩阵形状", () => {
    expect(DELIVERY_WAKEUP_MATRIX.deliveryOwner).toBe("sender");
    expect(DELIVERY_WAKEUP_MATRIX.wakeupOwner).toBe("tier0-watchman");
    expect(DELIVERY_WAKEUP_MATRIX.onWakeup).toBe("harvest-mailbox-first");
    expect(MAILBOX_SEGMENTS).toEqual(["unread", "delivering", "processed"]);
    expect(GATE_FLOW.from).toBe("pending");
    expect(RuntimeError).toBeDefined();
  });
});
