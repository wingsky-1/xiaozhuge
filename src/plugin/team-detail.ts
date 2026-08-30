/**
 * 团队详情只读 HTTP 面（issue #130）：GET /api/xiaozhuge/team/detail?session=。
 *
 * 只读组装零写路径：agents.json + 任务账本 + 信箱三段头部扫描 + 各房间黑板
 * 分片 → runtime 纯函数归约（src/runtime/view/detail.ts）→ JSON。路由骨架与
 * 轮询减负三件套（stat 指纹快路径 / per-TEAM_HOME single-flight / ETag-304）
 * 沿 team-overview.ts 先例；缓存实例独立于 overview（互不挤出）。
 *
 * 时钟 TTL 兜底（评审 E1）：本端点输出是「文件内容 × nowMs」的函数
 * （lastSeenAgeMs 与 stale 判定），指纹只含文件 stat 不含时钟——团队静默零写入
 * 期间指纹恒定，若无 TTL 则 304 会永久命中旧投影（lastSeenAgeMs 定格、超阈
 * 标注迟到乃至永不出现）。缓存条目携带 expiresAt = Date.now() +
 * DETAIL_CACHE_TTL_MS，304 仅在窗口内返回、过期即使指纹未变也强制重算刷新。
 *
 * ETag 为指纹串 sha256 hex 前 32 位（node:crypto 内置零依赖）：指纹串随信封数
 * 可达数百字节且泄目录结构，不宜直作 header 载体；指纹串仍是缓存 Map 键，
 * ETag 仅是其短摘要。同指纹 TTL 强制刷新时轮转内容代际号扰动摘要输入，保证
 * 客户端在窗口外拿到重算后的时钟派生量（见 CacheEntry.generation 注记）。
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { join } from "node:path";
import {
  DELIVERING_PREFIX,
  layout,
  Ledger,
  listShards,
  memberMailboxDir,
  PROCESSED_DIR,
  readJson,
  reduceDetail,
  Registry,
} from "../runtime/index.js";
import { readEventsTail } from "./team-overview.js";
import type {
  Envelope,
  MailboxEnvelopeState,
  MailboxHeadView,
  RoomEvent,
  RoomShard,
  TeamDetailView,
} from "../runtime/index.js";
import { SESSION_PATTERN } from "./session-id.js";

/** 路由路径。 */
export const ROUTES_DETAIL = "/api/xiaozhuge/team/detail";

/**
 * 缓存条目时钟 TTL（毫秒）：= STALE_THRESHOLD_MS 的 1/60。抽屉 5s 轮询下每
 * 约 6 个周期真实归约一次，stale 心跳年龄解析度 ≈30s，足以支撑「陈旧分钟级」
 * 展示；304 对客户端语义不变。
 */
export const DETAIL_CACHE_TTL_MS = 30_000;

/* ── 信箱三段头部读取（零写路径：不删除/移动任何文件）─────────────────── */

/**
 * 信封摘要读侧独立守卫（P1-3，#169 复核）：body 为 unknown、成员可伪造
 * task-assign 信封（team_send 无类型约束），故摘要只摘白名单键且必须满足
 * 「type==='task-assign' && body 为对象 && task_id/title 均为非空字符串」，
 * 否则 null——复用 receiptSummaryOf「写路径校验不可信历史，读侧独立守卫」先例。
 * body 原样永不出本函数（T15 脱敏断言保持）。
 */
function envelopeSummary(env: Envelope): string | null {
  if (env.type !== "task-assign") return null;
  const body = env.body;
  if (body === null || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const taskId = typeof b.task_id === "string" && b.task_id.length > 0 ? b.task_id : null;
  const title = typeof b.title === "string" && b.title.length > 0 ? b.title : null;
  if (taskId === null || title === null) return null;
  return `task ${taskId}：${title}`;
}

/**
 * 读单个信封并裁剪为白名单头部（坏 JSON 跳过——readEventsTail 坏行跳过同款，
 * 只读面不修复）；body 永不出本函数（仅 envelopeSummary 白名单摘录）。
 */
async function envelopeHead(
  file: string,
  state: MailboxEnvelopeState,
): Promise<MailboxHeadView | undefined> {
  let env: Envelope | undefined;
  try {
    env = await readJson<Envelope>(file);
  } catch {
    return undefined; // 坏 JSON：跳过该条
  }
  if (env === undefined) return undefined;
  return {
    id: env.id,
    to: env.to,
    from: env.from,
    type: env.type,
    state,
    createdAt: env.createdAt,
    summary: envelopeSummary(env),
  };
}

/**
 * 扫描成员信箱三段文件位并汇总头部：
 * - 未读位 `<member>/<uuid>.json`（非 `.` 开头 `*.json`）→ unread；
 * - 认领位 `<member>/.delivering-<uuid>.json` → claimed；
 * - 已确认 `<member>/processed/<uuid>.json` → acked。
 * 其余隐藏位（.tmp- 发送方暂存生态等）不入视图。目录不存在返回 []。
 */
export async function readMailboxHeads(teamHome: string, member: string): Promise<MailboxHeadView[]> {
  const dir = memberMailboxDir(teamHome, member);
  if (!existsSync(dir)) return [];
  const heads: MailboxHeadView[] = [];
  for (const entry of await readdir(dir)) {
    if (!entry.endsWith(".json")) continue;
    let state: MailboxEnvelopeState;
    if (!entry.startsWith(".")) state = "unread";
    else if (entry.startsWith(DELIVERING_PREFIX)) state = "claimed";
    else continue; // .tmp- 等暂存生态不入视图
    const head = await envelopeHead(join(dir, entry), state);
    if (head !== undefined) heads.push(head);
  }
  const processedDir = join(dir, PROCESSED_DIR);
  for (const entry of existsSync(processedDir) ? await readdir(processedDir) : []) {
    if (!entry.endsWith(".json")) continue;
    const head = await envelopeHead(join(processedDir, entry), "acked");
    if (head !== undefined) heads.push(head);
  }
  return heads;
}

/* ── 归约输入组装（IO 与纯函数的分界）──────────────────────────────────── */

/** 组装归约输入切片并投影：注册表 + 账本 + 逐房间分片/事件尾部 + 逐成员信箱头部。 */
export async function buildDetail(teamHome: string): Promise<TeamDetailView> {
  const l = layout(teamHome);
  const registry = await new Registry(teamHome).read();
  const ledgerList = await new Ledger(teamHome, l.ledgerTasksDir).list();
  // 房间集 = roomsDir 目录枚举（team-overview buildOverview 同款先例）。
  const roomNames = existsSync(l.roomsDir)
    ? readdirSync(l.roomsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    : [];
  const shards: RoomShard[] = [];
  const events: RoomEvent[] = [];
  for (const room of roomNames) {
    for (const shard of await listShards(teamHome, room)) {
      shards.push({ room, shard });
    }
    // Q2（#162）：事件尾部走字节窗口 readEventsTail（同 overview 读法），
    // 禁止全量 EventLog.read()（append-only 永不裁剪，长会话 O(全文件)）。
    events.push({ room, events: await readEventsTail(join(l.roomsDir, room, "events.jsonl")) });
  }
  // 成员集 = agents.json keys：协议外垃圾目录不拖慢扫描、不入视图。
  const mailboxes: MailboxHeadView[] = [];
  for (const member of Object.keys(registry.members).sort()) {
    for (const head of await readMailboxHeads(teamHome, member)) {
      mailboxes.push(head);
    }
  }
  return reduceDetail({
    registry,
    tasks: ledgerList.tasks,
    corruptTaskFiles: ledgerList.corrupt,
    mailboxes,
    shards,
    rooms: events,
    nowMs: Date.now(),
  });
}

/* ── 投影缓存：stat 指纹（含信箱三段/账本/分片覆盖集）+ single-flight + ETag + TTL ── */

interface CacheEntry {
  /** 内容指纹串（缓存匹配键，非 HTTP 载体）。 */
  fp: string;
  /** sha256(指纹串) hex 前 32 位（If-None-Match 载体；见 reduceCached 代际注记）。 */
  etag: string;
  body: TeamDetailView;
  /** expiresAt 前禁止 304：窗口外即使指纹未变也强制重算刷新时钟派生量。 */
  expiresAt: number;
  /**
   * 内容代际号：同指纹因 TTL 到期被强制重算时 +1 并扰动 ETag 输入
   * （[偏差-D2]）：若 ETag 恒为纯指纹摘要，指纹未变的 TTL 强刷会在 HTTP 层
   * 立即再次命中同值 ETag → 304，客户端永远拿不到重算后的 lastSeenAgeMs/
   * stale 标注——1.5「304 仅窗口内」与 T20「过期后 200」将互相矛盾且退化为
   * 永久 304。以 `fp#<generation>` 为摘要输入即可同时满足两者；fp 变化时代际
   * 归零，ETag 恢复为纯内容摘要。
   */
  generation: number;
}

/** per-TEAM_HOME 投影缓存（有界：超出上限清最旧，防长驻进程缓慢累积）。 */
const detailCache = new Map<string, CacheEntry>();
/** 缓存上限（与 team-overview CACHE_LIMIT 同值；实例彼此独立互不挤出）。 */
const CACHE_LIMIT = 128;
/** per-TEAM_HOME in-flight 归约（single-flight）。 */
const inflight = new Map<string, Promise<CacheEntry>>();

function fileStamp(path: string): string {
  try {
    const s = statSync(path);
    return `${s.mtimeMs.toFixed(3)}:${s.size}`;
  } catch {
    return "-"; // 文件缺失按 "-"，不报错
  }
}

/** 目录枚举兜底：缺失/不可读按空集处理（单输入降级，指纹不炸）。 */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * 输入文件集指纹：agents.json + ledger/tasks/*.json 每任务文件 +
 * rooms/<r>/state/*.json 每房间黑板分片 + rooms/<r>/events.jsonl 每房间
 * 事件流（Q2，#162：recentEvents 投影的数据源，缺失则事件更新不翻转指纹）
 * + mailbox/<m>/ 三段文件（未读位 `.json`、`.delivering-*.json`、
 * processed/*.json）任一变化即翻转键。
 * 全部输入 append-only / 原子写（ADR 0017），mtimeMs:size 指纹翻转可靠；
 * 枚举一律 sort 保证确定性（避免顺序抖动造成假 miss/ETag 抖动）。
 */
function fingerprint(teamHome: string): string {
  const l = layout(teamHome);
  const parts: string[] = [fileStamp(l.agentsJson)];
  for (const entry of safeReaddir(l.ledgerTasksDir)) {
    parts.push(`task|${entry}=${fileStamp(join(l.ledgerTasksDir, entry))}`);
  }
  for (const room of safeReaddir(l.roomsDir)) {
    const stateDir = join(l.roomsDir, room, "state");
    for (const entry of safeReaddir(stateDir)) {
      parts.push(`shard|${room}/${entry}=${fileStamp(join(stateDir, entry))}`);
    }
    parts.push(`events|${room}=${fileStamp(join(l.roomsDir, room, "events.jsonl"))}`);
  }
  for (const member of safeReaddir(l.mailboxDir)) {
    const dir = join(l.mailboxDir, member);
    for (const entry of safeReaddir(dir)) {
      if (entry === PROCESSED_DIR || !entry.endsWith(".json")) continue;
      // 未读位与非隐藏投递文件计入；其余隐藏位（.tmp- 暂存生态）不计。
      if (entry.startsWith(".") && !entry.startsWith(DELIVERING_PREFIX)) continue;
      parts.push(`mail|${member}/${entry}=${fileStamp(join(dir, entry))}`);
    }
    const processedDir = join(dir, PROCESSED_DIR);
    for (const entry of safeReaddir(processedDir)) {
      if (!entry.endsWith(".json")) continue;
      parts.push(`mail|${member}/processed/${entry}=${fileStamp(join(processedDir, entry))}`);
    }
  }
  return parts.join("|");
}

async function reduceCached(teamHome: string): Promise<CacheEntry> {
  const fp = fingerprint(teamHome);
  const cached = detailCache.get(teamHome);
  // 快路径必须同时满足：指纹未变 且 条目未过 TTL——TTL 是时钟输入的兜底，
  // 过期即投影已定格陈旧（lastSeenAgeMs/stale 标注），强制走真实归约刷新。
  if (cached !== undefined && cached.fp === fp && Date.now() < cached.expiresAt) return cached;
  // 同指纹 TTL 强刷轮转代际号（[偏差-D2]，见 CacheEntry 注记）；指纹变化则归零。
  const generation = cached !== undefined && cached.fp === fp ? cached.generation + 1 : 0;
  const body = await buildDetail(teamHome);
  const fresh: CacheEntry = {
    fp,
    etag: createHash("sha256").update(generation === 0 ? fp : `${fp}#${generation}`).digest("hex").slice(0, 32),
    body,
    expiresAt: Date.now() + DETAIL_CACHE_TTL_MS,
    generation,
  };
  if (detailCache.size >= CACHE_LIMIT) {
    const oldest = detailCache.keys().next().value;
    if (oldest !== undefined) detailCache.delete(oldest);
  }
  detailCache.set(teamHome, fresh);
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

let emptyBody: TeamDetailView | null = null;

/**
 * 非团队短路空投影：直接取「空输入归约」结果作单一事实源，保证与 reduceDetail
 * 输出形状永不漂移（team.yaml 不在场时 HTTP 层先行短路，不读任何文件）。
 */
function emptyDetailBody(): TeamDetailView {
  if (emptyBody === null) {
    emptyBody = reduceDetail({
      registry: { members: {} },
      tasks: [],
      corruptTaskFiles: [],
      mailboxes: [],
      shards: [],
      rooms: [],
      nowMs: 0,
    });
  }
  return emptyBody;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** 团队详情只读路由（GET-only；非团队短路；304 仅 TTL 窗口内返回）。 */
export function makeDetailRoute(teamHomeFor: (sessionId: string) => string): WebRoute {
  return {
    kind: "exact",
    path: ROUTES_DETAIL,
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
      // 非团队会话短路：实例根未初始化（team.yaml 快照不在场），与 overview 判定一致。
      if (!existsSync(layout(teamHome).teamYaml)) {
        writeJson(res, 200, emptyDetailBody());
        return;
      }
      try {
        const entry = await reduceOnce(teamHome);
        const raw = req.headers["if-none-match"];
        const clientEtag = Array.isArray(raw) ? raw[0] : raw;
        if (clientEtag === entry.etag && Date.now() < entry.expiresAt) {
          res.writeHead(304, { etag: entry.etag });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", etag: entry.etag });
        res.end(JSON.stringify(entry.body));
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}
