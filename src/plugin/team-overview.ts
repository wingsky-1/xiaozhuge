/**
 * 团队视图总览 HTTP 面（issue #68）：GET /api/xiaozhuge/team/overview?session=。
 *
 * 只读投影零写路径：agents.json + 各房间 events.jsonl 尾部窗口 + 各房间
 * state 目录黑板分片 → runtime 纯函数归约（src/runtime/view/overview.ts）→ JSON。
 * 复用 team/status 的 GET 先例（无 POST，不涉同源双头断言）。
 *
 * 尾部窗口语义（issue「归约 events.jsonl 尾部」）：文件超过 TAIL_WINDOW_BYTES
 * 时仅读末尾窗口字节，窗口起点落在行中间则丢弃首个残行——append-only 流的
 * 尾部即最新状态，头部历史对监控视图无增量价值。
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
  const start = size > maxBytes ? size - maxBytes : 0;
  let raw = start > 0 ? (await readFile(file)).subarray(start).toString("utf8") : await readFile(file, "utf8");
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
      if (!sessionId) {
        writeJson(res, 400, { error: "missing session parameter" });
        return;
      }
      const teamHome = teamHomeFor(sessionId);
      // 非团队会话短路：实例根未初始化（team.yaml 快照不在场），与 team/status 判定一致。
      if (!existsSync(layout(teamHome).teamYaml)) {
        writeJson(res, 200, { isTeam: false, members: [], rooms: [] });
        return;
      }
      try {
        writeJson(res, 200, await buildOverview(teamHome));
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}
