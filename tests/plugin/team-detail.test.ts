/**
 * 团队详情 HTTP 面测试（issue #130；gui-plan 第五章 5.2 矩阵 T12-T20）。
 * node:http 真实监听回环端口驱动 WebRoute，teamHomeFor 直接指向临时实例根
 * （不依赖宿主绑定层），形态沿 team-overview.test.ts 先例。
 *
 * 关键手法：
 * - T16 用 fs.utimesSync 强翻 mtime（C3：仅同 size 内容改动在 mtime 分辨率内
 *   未必翻转 stat 指纹）；
 * - T20 用 vi.useFakeTimers({ toFake: ["Date"] }) 只冻结时钟不打扰事件循环，
 *   验证 304 仅 TTL 窗口内返回（评审 E1：时钟输入兜底）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemberRecord } from "../../src/runtime/index.js";
import { DELIVERING_PREFIX, layout, STALE_THRESHOLD_MS } from "../../src/runtime/index.js";
import {
  DETAIL_CACHE_TTL_MS,
  makeDetailRoute,
  readMailboxHeads,
} from "../../src/plugin/team-detail.js";

/* ── fixture 工厂区 ─────────────────────────────────────────────────── */

/** 创建带 team.yaml 的空实例根。 */
function makeHome(prefix = "xzg-detail-"): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(layout(home).roomsDir, { recursive: true });
  writeFileSync(layout(home).teamYaml, JSON.stringify({ name: "demo", playbook_digest: "x" }));
  return home;
}

function memberOf(name: string, over: Partial<MemberRecord> = {}): MemberRecord {
  return {
    member: name,
    durableId: `dur-${name}`,
    parent: null,
    tier: 1,
    status: "running",
    lastSeen: 1,
    ...over,
  };
}

function writeAgents(home: string, members: Record<string, MemberRecord>): void {
  writeFileSync(layout(home).agentsJson, JSON.stringify({ members }));
}

function writeTask(home: string, record: Record<string, unknown>): void {
  const dir = layout(home).ledgerTasksDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${record.id as string}.json`), JSON.stringify(record));
}

function writeShard(home: string, room: string, shard: Record<string, unknown>): void {
  const dir = join(layout(home).roomsDir, room, "state");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${shard.role as string}.json`), JSON.stringify(shard));
}

function writeEnvelope(home: string, segment: "unread" | "delivering" | "processed", member: string, id: string, body: unknown): void {
  const memberDir = join(layout(home).mailboxDir, member);
  if (segment === "unread") {
    mkdirSync(memberDir, { recursive: true });
    writeFileSync(join(memberDir, `${id}.json`), JSON.stringify(envelopeRecord(id, member, body)));
    return;
  }
  if (segment === "delivering") {
    mkdirSync(memberDir, { recursive: true });
    writeFileSync(join(memberDir, `${DELIVERING_PREFIX}${id}.json`), JSON.stringify(envelopeRecord(id, member, body)));
    return;
  }
  mkdirSync(join(memberDir, "processed"), { recursive: true });
  writeFileSync(join(memberDir, "processed", `${id}.json`), JSON.stringify(envelopeRecord(id, member, body)));
}

function envelopeRecord(id: string, to: string, body: unknown): Record<string, unknown> {
  return { id, to, from: "master", type: "task-assign", body, createdAt: 42 };
}

/**
 * 标准团队 fixture：master(tier0 新鲜) + coder(超阈无免责 → stale) +
 * qa(超阈含 blocked 分片 → awaitingInput) + rt(无信箱目录 → T19 边界)；
 * 信件含脱敏占位（SECRET-PROMPT / NOTE-MARK，供 T15 负向断言）。
 */
function makeTeamFixture(home: string): void {
  const now = Date.now();
  const T = STALE_THRESHOLD_MS;
  writeAgents(home, {
    master: memberOf("master", { tier: 0, durableId: "s-root", lastSeen: now }),
    coder: memberOf("coder", { parent: "master", lastSeen: now - T * 10 }),
    qa: memberOf("qa", { parent: "master", lastSeen: now - T * 10 }),
    rt: memberOf("rt", { parent: "master", lastSeen: now }),
  });
  writeTask(home, {
    id: "task-1", title: "实现核心模块", status: "running", room: "root",
    assignee: "coder", touched: ["src/a.ts"], mutexGroups: [], rounds: 1, maxRounds: 3,
    dod: [], rev: 2, createdAt: 10, updatedAt: 100,
  });
  writeTask(home, {
    id: "task-2", title: "回归验证", status: "done", room: "root",
    assignee: "qa", touched: [], mutexGroups: [], rounds: 2, maxRounds: 3,
    dod: [], artifact: "archive/r2", rev: 5, createdAt: 11, updatedAt: 90,
  });
  writeShard(home, "root", {
    role: "qa", status: "blocked", updatedAt: 9,
    ext: { current_activity: "等待评审结论", hidden_note: "NOTE-MARK" },
  });
  writeEnvelope(home, "unread", "coder", "env-u", { prompt: "SECRET-PROMPT" });
  writeEnvelope(home, "processed", "coder", "env-p", { ack: true });
}

async function withServer(teamHome: string | null, run: (port: number) => Promise<void>): Promise<void> {
  const server: Server = createServer((req, res) => {
    void makeDetailRoute(() => teamHome ?? "/nonexistent").handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  try {
    await run(addr.port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const urlOf = (port: number): string => `http://127.0.0.1:${port}/api/xiaozhuge/team/detail?session=s0`;

type DetailBody = Record<string, unknown> & {
  isTeam?: boolean;
  tasks?: Array<Record<string, unknown>>;
  corruptTaskFiles?: string[];
  taskCounts?: Record<string, number>;
  envelopes?: Array<Record<string, unknown>>;
  shardBadges?: Array<Record<string, unknown>>;
  staleMembers?: Array<{ member: string; lastSeenAgeMs: number }>;
  awaitingInput?: Array<{ member: string; lastSeenAgeMs: number }>;
  recentEvents?: Array<Record<string, unknown>>;
};

const EMPTY_DETAIL_BODY: DetailBody = {
  isTeam: false,
  tasks: [],
  corruptTaskFiles: [],
  taskCounts: { queued: 0, running: 0, blocked: 0, done: 0, cancelled: 0 },
  envelopes: [],
  shardBadges: [],
  masterIdle: false,
  staleMembers: [],
  awaitingInput: [],
  recentEvents: [],
};

describe("GET /api/xiaozhuge/team/detail", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("T12: 缺 session → 400；非 GET → 405；路径逃逸 session → 400", async () => {
    await withServer(makeHome(), async (port) => {
      const base = `http://127.0.0.1:${port}`;
      const missing = await fetch(`${base}/api/xiaozhuge/team/detail`);
      expect(missing.status).toBe(400);
      expect(((await missing.json()) as { error: string }).error).toBe("invalid session parameter");
      const post = await fetch(`${base}/api/xiaozhuge/team/detail?session=s`, { method: "POST" });
      expect(post.status).toBe(405);
      const evil = await fetch(`${base}/api/xiaozhuge/team/detail?session=${encodeURIComponent("../../etc")}`);
      expect(evil.status).toBe(400);
    });
  });

  it("T13: team.yaml 不在场 → 200 全空形短路（isTeam:false），不读任何数据文件", async () => {
    const bare = mkdtempSync(join(tmpdir(), "xzg-detail-bare-"));
    await withServer(bare, async (port) => {
      const res = await fetch(urlOf(port));
      expect(res.status).toBe(200);
      expect((await res.json()) as DetailBody).toEqual(EMPTY_DETAIL_BODY);
    });
  });

  it("T14: happy path——全字段形状 + stale/awaiting 划分正确", async () => {
    const home = makeHome();
    makeTeamFixture(home);
    await withServer(home, async (port) => {
      const res = await fetch(urlOf(port));
      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toMatch(/^[0-9a-f]{32}$/);
      const body = (await res.json()) as DetailBody;
      expect(body.isTeam).toBe(true);
      // 任务按 updatedAt desc。
      expect(body.tasks!.map((t) => t.id)).toEqual(["task-1", "task-2"]);
      expect(body.taskCounts).toEqual({ queued: 0, running: 1, blocked: 0, done: 1, cancelled: 0 });
      expect(body.corruptTaskFiles).toEqual([]);
      // 信箱头部严格八键、state 映射正确、createdAt desc；信封 body 非
      // task_id+title 结构 → summary=null（PR-B 读侧守卫，脱敏不变）。
      expect(body.envelopes).toEqual([
        { id: "env-p", to: "coder", from: "master", type: "task-assign", state: "acked", createdAt: 42, summary: null },
        { id: "env-u", to: "coder", from: "master", type: "task-assign", state: "unread", createdAt: 42, summary: null },
      ]);
      // 分片徽标：房间维度平铺 + current_activity 单键提取。
      expect(body.shardBadges).toEqual([
        { room: "root", role: "qa", status: "blocked", updatedAt: 9, currentActivity: "等待评审结论" },
      ]);
      // stale 划分：coder 超阈无免责；qa 超阈但 blocked 分片免责；二者互斥。
      expect(body.staleMembers!.map((a) => a.member)).toEqual(["coder"]);
      expect(body.awaitingInput!.map((a) => a.member)).toEqual(["qa"]);
      // tier0 心跳新鲜 → 主控不怠工。
      expect("masterIdle" in body && body.masterIdle).toBe(false);
      expect(home).toBeTruthy();
    });
  });

  it("T14b: task-assign 信封 body 带 task_id+title → 白名单摘要入投影（PR-B，#169）", async () => {
    const home = makeHome();
    writeAgents(home, {
      master: memberOf("master", { tier: 0, durableId: "s-root" }),
      coder: memberOf("coder", { parent: "master" }),
    });
    writeEnvelope(home, "unread", "coder", "env-assign", { task_id: "task-1", title: "实现核心模块" });
    await withServer(home, async (port) => {
      const body = (await (await fetch(urlOf(port))).json()) as DetailBody;
      expect(body.envelopes).toEqual([
        {
          id: "env-assign",
          to: "coder",
          from: "master",
          type: "task-assign",
          state: "unread",
          createdAt: 42,
          summary: "task task-1：实现核心模块",
        },
      ]);
      // body 仍不出投影面（仅摘要白名单单键）。
      expect(JSON.stringify(body)).not.toContain('"body"');
    });
  });

  it("T15: 脱敏负向断言——信封 body 与分片 ext 非白名单键绝不出响应", async () => {
    const home = makeHome();
    makeTeamFixture(home);
    await withServer(home, async (port) => {
      const serialized = JSON.stringify(await (await fetch(urlOf(port))).json());
      expect(serialized).not.toContain("SECRET-PROMPT");
      expect(serialized).not.toContain("NOTE-MARK");
      expect(serialized).not.toContain('"body"');
      expect(serialized).not.toContain('"prompt"');
      expect(serialized).not.toContain('"hidden_note"');
      expect(serialized).not.toContain('"ext"');
    });
  });

  it("T16: If-None-Match 命中 → 304 空 body；utimesSync 强翻 mtime 后 ETag 变化 → 200 新数据", async () => {
    const home = makeHome();
    makeTeamFixture(home);
    await withServer(home, async (port) => {
      const first = await fetch(urlOf(port));
      expect(first.status).toBe(200);
      const etag1 = first.headers.get("etag")!;
      const cached = await fetch(urlOf(port), { headers: { "if-none-match": etag1 } });
      expect(cached.status).toBe(304);
      expect(await cached.text()).toBe("");

      // 同 size 级内容改动（master lastSeen 变更不影响成员名长度），并用
      // utimesSync 显式把 mtime 拨远 5s——确定性翻转 stat 指纹（规范 C3）。
      const agentsFile = layout(home).agentsJson;
      const raw = JSON.parse(readFileSync(agentsFile, "utf8")) as { members: Record<string, MemberRecord> };
      raw.members.coder.lastSeen += 4444;
      writeFileSync(agentsFile, JSON.stringify(raw));
      const st = statSync(agentsFile);
      utimesSync(agentsFile, new Date(st.atimeMs), new Date(st.mtimeMs + 5000));

      const refreshed = await fetch(urlOf(port), { headers: { "if-none-match": etag1 } });
      expect(refreshed.status).toBe(200);
      const etag2 = refreshed.headers.get("etag")!;
      expect(etag2).not.toBe(etag1);
      // 心跳前拨后年龄应缩小（真实时钟流逝导致毫秒级抖动，断言方向而非精确值）。
      const body2 = (await refreshed.json()) as DetailBody;
      const coderAge = body2.staleMembers!.find((a) => a.member === "coder")!.lastSeenAgeMs;
      expect(coderAge).toBeGreaterThan(STALE_THRESHOLD_MS * 10 - 8000);
      expect(coderAge).toBeLessThan(STALE_THRESHOLD_MS * 10 - 2000);
      // 指纹已刷新且仍在 TTL 窗口内：新 ETag 再次命中 304。
      const recached = await fetch(urlOf(port), { headers: { "if-none-match": etag2 } });
      expect(recached.status).toBe(304);
    });
  });

  it("T17: 指纹覆盖 processed 段——写入 processed/<uuid>.json 后 ETag 必然翻转", async () => {
    const home = makeHome();
    makeTeamFixture(home);
    await withServer(home, async (port) => {
      const before = await fetch(urlOf(port));
      const etag1 = before.headers.get("etag")!;
      const count1 = ((await before.json()) as DetailBody).envelopes!.length;

      writeEnvelope(home, "processed", "coder", "env-extra", {});
      const after = await fetch(urlOf(port));
      expect(after.status).toBe(200);
      expect(after.headers.get("etag")).not.toBe(etag1);
      const body2 = (await after.json()) as DetailBody;
      expect(body2.envelopes!.length).toBe(count1 + 1);
      expect(body2.envelopes!.some((e) => e.id === "env-extra" && e.state === "acked")).toBe(true);
    });
  });

  it("T18: 账本损坏——corruptTaskFiles 如实透传，HTTP 仍 200", async () => {
    const home = makeHome();
    makeTeamFixture(home);
    writeFileSync(join(layout(home).ledgerTasksDir, "broken-task.json"), "{not-json");
    await withServer(home, async (port) => {
      const res = await fetch(urlOf(port));
      expect(res.status).toBe(200);
      const body = (await res.json()) as DetailBody;
      expect(body.corruptTaskFiles).toEqual(["broken-task.json"]);
      expect(body.tasks!.map((t) => t.id)).toEqual(["task-1", "task-2"]);
    });
  });

  it("T19: 信箱目录缺失——该成员空数组，HTTP 不炸不 500", async () => {
    const home = makeHome();
    makeTeamFixture(home); // rt 成员自始至终没有 mailbox/rt 目录
    expect(existsSync(join(layout(home).mailboxDir, "rt"))).toBe(false);
    await withServer(home, async (port) => {
      const res = await fetch(urlOf(port));
      expect(res.status).toBe(200);
      const body = (await res.json()) as DetailBody;
      expect(body.envelopes!.every((e) => e.to !== "rt")).toBe(true);
      expect(await readMailboxHeads(home, "ghost-member")).toEqual([]);
    });
  });

  it("T20: TTL 过期重算（E1）——304 仅 TTL 窗口内返回，过期后时钟派生量被重新计算", async () => {
    const home = makeHome();
    const T = STALE_THRESHOLD_MS;
    const NOW = 3_000_000_000_000;
    // coder 离超阈差 20s：首查未 stale；时钟推进跨过阈值后才应出现标注。
    writeAgents(home, {
      master: memberOf("master", { tier: 0, durableId: "s-root", lastSeen: Number.MAX_SAFE_INTEGER }),
      coder: memberOf("coder", { parent: "master", lastSeen: NOW - (T - 20_000) }),
    });
    vi.useFakeTimers({ toFake: ["Date"] }); // 只冻结时钟，不打扰网络事件循环
    try {
      vi.setSystemTime(NOW);
      await withServer(home, async (port) => {
        const first = await fetch(urlOf(port));
        expect(first.status).toBe(200);
        const b1 = (await first.json()) as DetailBody;
        expect(b1.staleMembers).toEqual([]); // 年龄 = 阈值 - 20s 未超阈
        const etag = first.headers.get("etag")!;

        // 指纹未变 + TTL 窗口内（21s < 30s）→ 304。
        vi.setSystemTime(NOW + 21_000);
        const windowed = await fetch(urlOf(port), { headers: { "if-none-match": etag } });
        expect(windowed.status).toBe(304);
        expect(await windowed.text()).toBe("");

        // 推进越过 TTL（35s > 30s）：即使 If-None-Match 命中同一 ETag 也必须
        // 强制重算 → 200，且 stale 标注出现、lastSeenAgeMs 为重新计算的年龄。
        vi.setSystemTime(NOW + DETAIL_CACHE_TTL_MS + 5_000);
        const expired = await fetch(urlOf(port), { headers: { "if-none-match": etag } });
        expect(expired.status).toBe(200);
        const b3 = (await expired.json()) as DetailBody;
        expect(b3.staleMembers).toEqual([{ member: "coder", lastSeenAgeMs: T + 15_000 }]);
        // [偏差-D2] 同指纹强刷轮转代际号 → ETag 已随重算更新；客户端换用新
        // ETag 后重新进入 304 窗口（滚动节流语义）。
        const freshEtag = expired.headers.get("etag")!;
        expect(freshEtag).not.toBe(etag);
        const rolled = await fetch(urlOf(port), { headers: { "if-none-match": freshEtag } });
        expect(rolled.status).toBe(304);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("readMailboxHeads：三段文件位 → state 映射（T6 真实验证面）", () => {
  it("unread/.delivering-/processed 三段各自映射；.tmp- 暂存位与坏 JSON 跳过；不删除任何文件", () => {
    const home = makeHome("xzg-detail-mail-");
    writeEnvelope(home, "unread", "coder", "e1", { p: "PROMPT-MARK" });
    writeEnvelope(home, "delivering", "coder", "e2", {});
    writeEnvelope(home, "processed", "coder", "e3", {});
    // 发送方暂存生态与坏 JSON 均不入视图。
    const memberDir = join(layout(home).mailboxDir, "coder");
    writeFileSync(join(memberDir, ".tmp-outgoing-x.json"), JSON.stringify({ id: "tmp" }));
    writeFileSync(join(memberDir, "broken.json"), "{nope");

    return readMailboxHeads(home, "coder").then((heads) => {
      // 目录枚举序不确定，按 id 归集断言（排序确定性由归约端覆盖）。
      expect(heads.map((h) => [h.id, h.state]).sort()).toEqual([
        ["e1", "unread"],
        ["e2", "claimed"],
        ["e3", "acked"],
      ]);
      const serialized = JSON.stringify(heads);
      expect(serialized).not.toContain("PROMPT-MARK"); // body 裁剪白名单外
      expect(serialized).not.toContain('"body"');
      // 读面纪律：零删除。
      expect(existsSync(join(memberDir, "broken.json"))).toBe(true);
      expect(existsSync(join(memberDir, ".tmp-outgoing-x.json"))).toBe(true);
    });
  });

  it("三段 createdAt 不同值时排序稳定性由归约端保证（此处仅验证原始头部如实读取）", async () => {
    const home = makeHome("xzg-detail-mail2-");
    const memberDir = join(layout(home).mailboxDir, "solo");
    mkdirSync(join(memberDir, "processed"), { recursive: true });
    const rec = (id: string, createdAt: number): Record<string, unknown> => ({
      id, to: "solo", from: "m", type: "t", body: null, createdAt,
    });
    writeFileSync(join(memberDir, "b-newer.json"), JSON.stringify(rec("b", 300)));
    writeFileSync(join(memberDir, "a-older.json"), JSON.stringify(rec("a", 100)));
    writeFileSync(join(memberDir, `${DELIVERING_PREFIX}c-mid.json`), JSON.stringify(rec("c", 200)));
    const heads = await readMailboxHeads(home, "solo");
    expect(heads).toHaveLength(3);
    expect(heads.every((h) => h.from === "m" && h.type === "t")).toBe(true);
  });
});
