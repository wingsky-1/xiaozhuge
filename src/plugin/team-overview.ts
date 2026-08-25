/**
 * 团队视图总览 HTTP 面（issue #68）：GET /api/xiaozhuge/team/overview?session=。
 *
 * 只读投影零写路径：agents.json + 各房间 events.jsonl 尾部窗口 + 各房间
 * state 目录黑板分片 → runtime 纯函数归约（src/runtime/view/overview.ts）→ JSON。
 * 复用 team/status 的 GET 先例（无 POST，不涉同源双头断言）。
 *
 * 尾部窗口语义（issue「归约 events.jsonl 尾部」）：文件超过 TAIL_WINDOW_BYTES
 * 时仅读末尾窗口字节，窗口起点落在行中间则丢弃首个残行——append-only 流的
 * 尾部即最新状态，头部历史对监控视图无增量价值；坏行跳过与 EventLog 写入侧
 * torn-tail 语义一致。
 *
 * 轮询减负三件套（对抗性评审阻塞项）：stat 快路径（输入文件 mtime+size 未变
 * 直接回缓存投影）、per-TEAM_HOME single-flight（并发轮询合并为一次解析）、
 * ETag/304（内容指纹未变空响应体）。前端 5s×N 窗口的绝大多数周期落在此处，
 * 不产生解析成本。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { join } from "node:path";
import type { EventRecord, TeamOverview } from "../runtime/index.js";
import { layout, listShards, reduceOverview, Registry } from "../runtime/index.js";

/** 路由路径。 */
export const ROUTES_OVERVIEW = "/api/xiaozhuge/team/overview";

/** 事件尾部读取窗口上限（字节）。 */
export const TAIL_WINDOW_BYTES = 256 * 1024;
/** 投影进视图模型的尾部事件条数上限。 */
export const TAIL_EVENT_LIMIT = 50;

/** session 参数白名单：防路径拼接逃逸（存量路由未校验，本路由不得复制该隐患）。 */
const SESSION_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** 读 jsonl 尾部窗口并解析为事件记录（残行丢弃，坏行跳过）。 */
export async function readEventsTail(
  file: string,
  maxBytes = TAIL_WINDOW_BYTES,
): Promise<EventRecord[]> {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  if (size === 0) return [];
  const start = size > maxBytes ? size - maxBytes : 0;
  const buf = await readFile(file);
  let raw = start > 0 ? buf.subarray(start).toString("utf8") : buf.toString("utf8");
  const lines = raw.split("\n");
  // 从窗口中段起读时首行大概率残缺：丢弃。
  if (start > 0 && lines.length > 0) lines.shift();
  const events: EventRecord[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed) as EventRecord);
    } catch {
      // torn tail / 坏行：跳过（只读面不做修复）。
    }
  }
  return events.slice(-TAIL_EVENT_LIMIT);
}

/** 组装归约输入并投影（IO 与纯函数的分界）。 */
export async function buildOverview(teamHome: string): Promise<TeamOverview> {
  const l = layout(teamHome);
  const registry = await new Registry(teamHome).read();
  const roomNames = existsSync(l.roomsDir)
    ? readdirSync(l.roomsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    : [];
  const rooms = [];
  for (const room of roomNames) {
    const dir = join(l.roomsDir, room);
    rooms.push({
      room,
      events: await readEventsTail(join(dir, "events.jsonl")),
      shards: await listShards(teamHome, room),
    });
  }
  return reduceOverview({ registry, rooms });
}

/* ---------------- 投影缓存：stat 指纹 + single-flight + ETag ---------------- */

interface CacheEntry {
  /** 内容指纹（agents.json + 各房间 events.jsonl 的 mtimeMs:size 串列哈希）。 */
  etag: string;
  body: TeamOverview;
}

/** per-TEAM_HOME 投影缓存（有界：超出上限清最旧，防长驻进程缓慢累积）。 */
const overviewCache = new Map<string, CacheEntry>();
const CACHE_LIMIT = 128;
/** per-TEAM_HOME in-flight 归约（single-flight）。 */
const inflight = new Map<string, Promise<CacheEntry>>();

function fileStamp(path: string): string {
  if (!existsSync(path)) return "-";
  const s = statSync(path);
  return `${s.mtimeMs.toFixed(3)}:${s.size}`;
}

/** 输入文件集指纹：任一事件流/注册表变化即翻转。 */
function fingerprint(teamHome: string): string {
  const l = layout(teamHome);
  const parts = [fileStamp(l.agentsJson)];
  if (existsSync(l.roomsDir)) {
    for (const entry of readdirSync(l.roomsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      parts.push(`${entry.name}=${fileStamp(join(l.roomsDir, entry.name, "events.jsonl"))}`);
    }
  }
  return parts.join("|");
}

async function reduceCached(teamHome: string): Promise<CacheEntry> {
  const fp = fingerprint(teamHome);
  const cached = overviewCache.get(teamHome);
  if (cached !== undefined && cached.etag === fp) return cached;
  const body = await buildOverview(teamHome);
  const fresh: CacheEntry = { etag: fp, body };
  if (overviewCache.size >= CACHE_LIMIT) {
    const oldest = overviewCache.keys().next().value;
    if (oldest !== undefined) overviewCache.delete(oldest);
  }
  overviewCache.set(teamHome, fresh);
  return fresh;
}

/** single-flight 包装：并发轮询合并为一次归约解析。 */
function reduceOnce(teamHome: string): Promise<CacheEntry> {
  const running = inflight.get(teamHome);
  if (running !== undefined) return running;
  const p = reduceCached(teamHome).finally(() => inflight.delete(teamHome));
  inflight.set(teamHome, p);
  return p;
}

/** 团队总览只读路由。 */
export function makeOverviewRoute(teamHomeFor: (sessionId: string) => string): WebRoute {
  return {
    kind: "exact",
    path: ROUTES_OVERVIEW,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET") {
        writeJson(res, 405, { error: "method not allowed" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const sessionId = url.searchParams.get("session");
      if (!sessionId || !SESSION_PATTERN.test(sessionId)) {
        writeJson(res, 400, { error: "invalid session parameter" });
        return;
      }
      const teamHome = teamHomeFor(sessionId);
      // 非团队会话短路：实例根未初始化（team.yaml 快照不在场），与 team/status 判定一致。
      if (!existsSync(layout(teamHome).teamYaml)) {
        writeJson(res, 200, { isTeam: false, members: [], rooms: [] });
        return;
      }
      try {
        const { etag, body } = await reduceOnce(teamHome);
        const clientEtag = req.headers["if-none-match"];
        if (clientEtag === etag) {
          res.writeHead(304, { etag });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", etag });
        res.end(JSON.stringify(body));
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}
