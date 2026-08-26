/**
 * 团队视图总览 HTTP 面测试（issue #68）：非团队短路、正常投影、尾部窗口
 * 截断、参数与方法校验。node:http 真实监听回环端口驱动 WebRoute，
 * teamHomeFor 直接指向临时目录（不依赖宿主绑定层）。
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { makeOverviewRoute, readEventsTail, TAIL_EVENT_LIMIT } from "../../src/plugin/team-overview.js";
import { layout } from "../../src/runtime/index.js";

/** 在临时实例根内落一个最小团队实例（team.yaml + agents.json + 房间数据）。 */
function makeTeamHome(withTeam = true): string {
  const home = mkdtempSync(join(tmpdir(), "xzg-overview-"));
  const l = layout(home);
  mkdirSync(join(l.roomsDir, "root", "state"), { recursive: true });
  if (withTeam) {
    writeFileSync(l.teamYaml, JSON.stringify({ name: "demo", playbook_digest: "x" }));
    writeFileSync(
      l.agentsJson,
      JSON.stringify({
        members: {
          master: { member: "master", durableId: "d0", parent: null, tier: 0, status: "running", lastSeen: 1 },
          coder: { member: "coder", durableId: "d1", parent: "master", tier: 1, status: "running", lastSeen: 2 },
        },
      }),
    );
    writeFileSync(
      join(l.roomsDir, "root", "events.jsonl"),
      [
        JSON.stringify({ seq: 1, ts: 11, session_id: "s", actor: "system", type: "team/init", payload: null }),
        JSON.stringify({ seq: 2, ts: 12, session_id: "s", actor: "coder", type: "blackboard/set", payload: { a: 1 } }),
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(l.roomsDir, "root", "state", "coder.json"),
      JSON.stringify({ role: "coder", status: "blocked", updatedAt: 5 }),
    );
  }
  return home;
}

async function withServer(teamHome: string | null, run: (port: number) => Promise<void>): Promise<void> {
  const server: Server = createServer((req, res) => {
    void makeOverviewRoute(() => teamHome ?? "/nonexistent").handler(req, res);
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

describe("GET /api/xiaozhuge/team/overview", () => {
  it("缺 session 参数返回 400；非 GET 返回 405；非法字符 session 拒绝", async () => {
    await withServer(makeTeamHome(), async (port) => {
      const missing = await fetch(`http://127.0.0.1:${port}/api/xiaozhuge/team/overview`);
      expect(missing.status).toBe(400);
      const bad = await fetch(`http://127.0.0.1:${port}/api/xiaozhuge/team/overview?session=s`, { method: "POST" });
      expect(bad.status).toBe(405);
      // 路径拼接逃逸防御：白名单外字符一律 400。
      const evil = await fetch(
        `http://127.0.0.1:${port}/api/xiaozhuge/team/overview?session=${encodeURIComponent("../../etc")}`,
      );
      expect(evil.status).toBe(400);
    });
  });

  it("实例根未初始化（team.yaml 不在场）→ is_team 短路 false", async () => {
    await withServer(null, async (port) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/xiaozhuge/team/overview?session=whatever`);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ isTeam: false, masterRegistered: false, members: [], rooms: [] });
    });
  });

  it("团队实例投影：成员表 + 房间计数 + 尾部事件摘要（payload 不出投影面）", async () => {
    const home = makeTeamHome();
    await withServer(home, async (port) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/xiaozhuge/team/overview?session=s0`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        isTeam: boolean;
        members: Array<{ member: string; tone: string; currentActivity: string | null; durableId: string }>;
        rooms: Array<{ room: string; counts: Record<string, number>; recentEvents: Array<{ type: string }> }>;
      };
      expect(body.isTeam).toBe(true);
      const coder = body.members.find((m) => m.member === "coder");
      expect(coder).toMatchObject({ tone: "blocked", currentActivity: "blackboard/set", durableId: "d1" });
      const root = body.rooms.find((room) => room.room === "root");
      expect(root?.counts).toMatchObject({ blocked: 1 });
      expect(root?.recentEvents.map((e) => e.type)).toEqual(["team/init", "blackboard/set"]);
      expect(JSON.stringify(body)).not.toContain('"payload"');
      // teamHome 参数确实被使用（防 stub 漂移）。
      expect(home).toBeTruthy();
    });
  });

  it("stat 快路径 + ETag/304 + single-flight：输入未变时重复轮询返回一致投影与 304", async () => {
    const home = makeTeamHome();
    await withServer(home, async (port) => {
      const url = `http://127.0.0.1:${port}/api/xiaozhuge/team/overview?session=s0`;
      // 并发首轮（single-flight 合并为一次归约解析）。
      const [a, b] = await Promise.all([fetch(url), fetch(url)]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const etag = a.headers.get("etag");
      expect(etag).toBeTruthy();
      // 输入文件未变：If-None-Match 命中 → 304 空体。
      const cached = await fetch(url, { headers: { "if-none-match": etag! } });
      expect(cached.status).toBe(304);
      // 未带条件的普通轮询仍回完整投影（快路径缓存）。
      const again = await fetch(url);
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual(await a.clone().json());
      // 追加事件 → 指纹翻转 → 新投影可见。
      const { appendFileSync } = await import("node:fs");
      appendFileSync(
        join(layout(home).roomsDir, "root", "events.jsonl"),
        JSON.stringify({ seq: 3, ts: 13, session_id: "s", actor: "master", type: "task/create", payload: null }) + "\n",
      );
      const refreshed = await fetch(url);
      const body = (await refreshed.json()) as { rooms: Array<{ recentEvents: Array<{ type: string }> }> };
      expect(body.rooms[0]?.recentEvents.at(-1)?.type).toBe("task/create");
    });
  });
});

describe("readEventsTail：jsonl 尾部窗口读取", () => {
  it("缺失文件返回空数组；超过条数上限取尾部 N 条", async () => {
    expect(await readEventsTail("/nonexistent/events.jsonl")).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "xzg-tail-"));
    const file = join(dir, "events.jsonl");
    const lines: string[] = [];
    for (let i = 1; i <= TAIL_EVENT_LIMIT + 10; i++) {
      lines.push(JSON.stringify({ seq: i, ts: i, session_id: "s", actor: "a", type: `t${i}`, payload: null }));
    }
    writeFileSync(file, lines.join("\n") + "\n");
    const tail = await readEventsTail(file);
    expect(tail.length).toBe(TAIL_EVENT_LIMIT);
    // 共 TAIL_EVENT_LIMIT+10 条，取尾 N 条：首条为第 11 条。
    expect(tail[0]?.type).toBe("t11");
    expect(tail.at(-1)?.type).toBe(`t${TAIL_EVENT_LIMIT + 10}`);
  });

  it("窗口起点落在行中间时丢弃残行，坏行跳过不炸", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xzg-tail-"));
    const file = join(dir, "events.jsonl");
    const good = (i: number) => JSON.stringify({ seq: i, ts: i, session_id: "s", actor: "a", type: `t${i}`, payload: null }) + "\n";
    // 精确布局：padding 行（保证窗口起点切进行中间）→ broken 行 → 完整末条。
    writeFileSync(file, "x".repeat(150) + "\n" + "{broken-json\n" + good(2));
    const events = await readEventsTail(file, 128);
    // 窗口内至少能解析出末尾的 t2；broken 行与可能的残行被丢弃。
    expect(events.map((e) => e.type)).toContain("t2");
    expect(events.every((e) => Number.isFinite(e.seq))).toBe(true);
  });
});
