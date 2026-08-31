/**
 * 会话→团队反查索引（ADR 0021）：把 `resolveTeamHomeForView` 的全目录同步扫描
 * 替换为 SQLite 单表索引，读面 O(log n) 定位，根治「每次 HTTP 请求同步枚举
 * sessions 目录 + 逐实例读 agents.json」造成的 Node 事件循环阻塞。
 *
 * - 写面：`handlers.ts` 的 spawn/dispatch 在成员登记（upsertMember）成功后
 *   调 `set()`，仅登记 durableId→(teamHome, member) 映射；touchMember 心跳与
 *   setStatus 不触发（映射不变，避免高频写放大）。init 登记 tier0 主控按
 *   `tier>0` 守卫跳过（主控直查已覆盖）。登记后同 home 对账清理残留条目
 *   （接管换 durableId 的错检防护，见 pruneTeam）。
 * - 读面：`team-home.ts` 的 `resolveTeamHomeForView` 直查 team.yaml 后先查索引，
 *   miss 才回退全目录扫描（自愈回填 + 负缓存限流）。
 * - 一致性：agents.json 是事实源（SOT），本索引是派生物；索引失效路径只能是
 *   「漏检」（miss→回扫自愈），不能是「错检」——索引命中分支必须保留 team.yaml
 *   在场性守卫。
 * - 降级：node:sqlite 不可用（Node 22.0-22.12 需 flag）或打开失败 → `sessionIndexFor`
 *   返回 null，反查回落旧全扫，行为正确性不破，仅损失优化。
 *
 * 生命周期：模块级 per-DSH_HOME 惰性单例；`closeSessionIndex`/`resetSessionIndex`
 * 供插件卸载与测试隔离。node:sqlite 是 Node 内置模块，不算新增第三方依赖。
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";

/** 反查索引文件相对 DSH_HOME 的落点（ADR 0021；可见形态，非隐藏点号文件）。 */
export const INDEX_REL_PATH = join("xiaozhuge", "index.sqlite");

/** 索引键长度上限：对齐 SESSION_PATTERN 1-128 放宽容（durableId 可含任意字符），超长拒绝防污染 B-tree。 */
export const INDEX_KEY_MAX = 256;

/** 单条反查结果。 */
export interface SessionIndexEntry {
  teamHome: string;
  member: string;
}

let sqliteAvailable: boolean | null = null;
let DatabaseSyncCtor: (typeof DatabaseSync) | undefined;

/**
 * feature-detect node:sqlite（Node 22.5+ 引入，22.13/23.4+ 默认可用，24 稳定）。
 * 用 createRequire 同步探测（不 import 顶层，避免不支持环境模块加载失败）。
 */
function detectDatabaseSync(): typeof DatabaseSync | undefined {
  if (sqliteAvailable === null) {
    try {
      const mod = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof DatabaseSync };
      DatabaseSyncCtor = mod.DatabaseSync;
      sqliteAvailable = typeof mod.DatabaseSync === "function";
    } catch {
      sqliteAvailable = false;
    }
  }
  return DatabaseSyncCtor;
}

/** per-DSH_HOME 惰性单例表。 */
const instances = new Map<string, SessionIndex | null>();

/** 索引打开失败的 DSH_HOME 集合（进程内不再重试，反查回落旧全扫）。 */
const disabledHomes = new Set<string>();

/**
 * SQLite 反查索引句柄。所有方法同步（DatabaseSync 同步 API）；写失败不抛错
 * （best-effort，与 heartbeat 吞错同哲学——索引是派生物，漏检由 miss 回扫自愈）。
 */
export class SessionIndex {
  private readonly home: string;
  private readonly db: DatabaseSync;
  private readonly stmtGet: StatementSync;
  private readonly stmtSet: StatementSync;
  private readonly stmtRemove: StatementSync;
  private readonly stmtByTeam: StatementSync;

  private constructor(home: string, db: DatabaseSync) {
    this.home = home;
    this.db = db;
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 3000");
    db.exec(
      "CREATE TABLE IF NOT EXISTS session_index (" +
        "session_id TEXT PRIMARY KEY, " +
        "team_home TEXT NOT NULL, " +
        "member TEXT NOT NULL" +
        ")",
    );
    this.stmtGet = db.prepare("SELECT team_home, member FROM session_index WHERE session_id = ?");
    this.stmtSet = db.prepare(
      "INSERT INTO session_index (session_id, team_home, member) VALUES (?, ?, ?) " +
        "ON CONFLICT(session_id) DO UPDATE SET team_home = excluded.team_home, member = excluded.member",
    );
    this.stmtRemove = db.prepare("DELETE FROM session_index WHERE session_id = ?");
    this.stmtByTeam = db.prepare("SELECT session_id FROM session_index WHERE team_home = ?");
  }

  /** 打开（完成 schema 初始化）；失败抛错由调用方捕获转为禁用态。 */
  static open(home: string, db: DatabaseSync): SessionIndex {
    return new SessionIndex(home, db);
  }

  /** 反查：sessionId（durable id）→ 归属实例与成员名；无条目返回 undefined。 */
  get(sessionId: string): SessionIndexEntry | undefined {
    if (sessionId.length === 0 || sessionId.length > INDEX_KEY_MAX) return undefined;
    try {
      const row = this.stmtGet.get(sessionId) as { team_home?: string; member?: string } | undefined;
      if (row === undefined || row.team_home === undefined || row.member === undefined) return undefined;
      return { teamHome: row.team_home, member: row.member };
    } catch {
      return undefined; // 查询异常按未命中处理，走旧回扫自愈
    }
  }

  /** 登记/更新映射（幂等 upsert）。失败静默——索引是派生物，不阻塞主写事务。 */
  set(sessionId: string, teamHome: string, member: string): void {
    if (sessionId.length === 0 || sessionId.length > INDEX_KEY_MAX) return;
    if (teamHome.length === 0 || member.length === 0) return;
    try {
      this.stmtSet.run(sessionId, teamHome, member);
    } catch {
      // best-effort：忽略（漏检由 miss 回扫自愈）
    }
  }

  /** 删除单条（索引命中但实例未初始化时惰性清理）。 */
  remove(sessionId: string): void {
    if (sessionId.length === 0 || sessionId.length > INDEX_KEY_MAX) return;
    try {
      this.stmtRemove.run(sessionId);
    } catch {
      // best-effort
    }
  }

  /**
   * 写面对账（QA 必须修正项）：清理同 teamHome 下**不在** validDurableIds 集合中的
   * 索引残留条目——覆盖「接管换 durableId」场景：成员换新 durableId 后 agents.json
   * （SOT）只含新 id，旧 id 若仍留在索引会被反查误判为成员（错检 + 残留写权限）。
   * 全量对账（而非只删旧条目）：登记是低频写操作（每任务派发一次），读一次
   * agents.json + 按 teamHome 批量删除，量级受控。
   */
  pruneTeam(teamHome: string, validDurableIds: ReadonlySet<string>): void {
    if (teamHome.length === 0) return;
    try {
      const rows = this.stmtByTeam.all(teamHome) as Array<{ session_id: string }>;
      for (const row of rows) {
        if (!validDurableIds.has(row.session_id)) {
          this.stmtRemove.run(row.session_id);
        }
      }
    } catch {
      // best-effort：对账失败静默（漏检由 miss 回扫自愈）
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // 已关闭忽略
    }
    // 关闭即从单例表移除：同 DSH_HOME 后续再取将重新打开（测试 reset/热重载语义）。
    instances.delete(this.home);
  }
}

/** 解析 DSH_HOME（与 team-home.resolveDshHome 同口径，避免循环依赖本地内联）。 */
function dshHomeOf(): string {
  return process.env.DSH_HOME ?? join(process.env.HOME ?? "", ".dsh");
}

/**
 * 写面守卫：判定 teamHome 是否落在当前 DSH_HOME 的 sessions 根下
 * （`<DSH_HOME>/xiaozhuge/sessions/<rootSession>` 目录协议内）。
 * 测试等非目录协议形态的临时 teamHome（裸 mkdtemp）跳过登记，防止污染
 * 真实 `~/.dsh/xiaozhuge/index.sqlite` 与无意义的索引写入。
 */
export function isTeamHomeUnderSessionsRoot(teamHome: string): boolean {
  const sessionsRoot = join(dshHomeOf(), "xiaozhuge", "sessions");
  const prefix = sessionsRoot.endsWith("/") ? sessionsRoot : sessionsRoot + "/";
  return teamHome.startsWith(prefix);
}

/**
 * 获取当前 DSH_HOME 的索引句柄；不可用/打开失败返回 null（反查回落旧全扫）。
 * 惰性：首用才创建；打开失败记入 disabledHomes，进程内不重试。
 */
export function sessionIndexFor(dshHome?: string): SessionIndex | null {
  const home = dshHome ?? dshHomeOf();
  const cached = instances.get(home);
  if (cached !== undefined) return cached;
  if (disabledHomes.has(home)) return null;
  const Ctor = detectDatabaseSync();
  if (Ctor === undefined) {
    disabledHomes.add(home);
    return null;
  }
  try {
    const dbPath = join(home, INDEX_REL_PATH);
    // 打开前确保父目录存在（新 DSH_HOME 可能尚无 xiaozhuge/ 目录，否则
    // DatabaseSync 打开会因 ENOENT 抛错被误判为"索引不可用"）。
    mkdirSync(dirname(dbPath), { recursive: true });
    const index = SessionIndex.open(home, new Ctor(dbPath));
    instances.set(home, index);
    return index;
  } catch {
    disabledHomes.add(home);
    return null;
  }
}

/** 插件卸载：关闭全部实例并清理状态（供 host.ts dispose）。 */
export function closeSessionIndex(): void {
  for (const idx of [...instances.values()]) idx?.close();
  instances.clear();
  disabledHomes.clear();
}

/** 测试隔离：同 closeSessionIndex（供 vitest afterEach 复用，语义一致）。 */
export function resetSessionIndex(): void {
  closeSessionIndex();
}
