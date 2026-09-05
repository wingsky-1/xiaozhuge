/**
 * append-only 事件流（rooms/<room>/events.jsonl，多写者串行化）。
 *
 * 写者约定：同一房间同一进程内允许多个运行时实例（A1 后主控与其子代理共享
 * 同一 events.jsonl）并发 append——本层以事件文件绝对路径为键的进程内写队列
 * （Promise 链）串行化写入并保证 seq 单调不重复；多进程并发写同 room 仍属
 * 协议违规，本层不做跨进程仲裁（事件流仅运行时单写者约定见 docs 11§5）。
 *
 * 崩溃容错：append 半途 kill 会留下截断尾行——初始化扫描与回放读取均跳过
 * 末尾坏行并如实报告（tornTail），不因坏行抛错。
 */
import { existsSync } from "node:fs";
import { open, readFile, stat, writeFile } from "node:fs/promises";
import type { EventRecord } from "./types.js";

/**
 * 进程内写队列：以事件文件绝对路径为键的 Promise 链，串行化 append。
 * 参考 team-overview.ts reduceOnce 的 inflight 模式（single-flight 合并与
 * 此处排队执行本质不同：本队列每个 append 都必须执行，只是互斥排队）。
 */
const writeChains = new Map<string, Promise<unknown>>();

/**
 * 进程内共享 seq 游标：以事件文件绝对路径为键。init 扫描恢复、append 推进；
 * 同一进程内多个 EventLog 实例共享，杜绝 per-instance `nextSeq++` 的重复 seq。
 * 与 DSH_HOME 运行期变更一样，跨进程 seq 不在此收敛（进程重启后 init 重扫）。
 */
const seqCursors = new Map<string, number>();

/**
 * #187 尾窗化：末笔 seq 读游标缓存（key=文件绝对路径）。append 成功与 init
 * 扫描后同步（size+seq 成对），lastSeq 快路径据此免内容读；size 不匹配
 * （含跨进程写，协议违规）时走尾窗慢路径，以文件实况为准——游标只可能
 * 因缓存过期而重扫，不会高估 seq。
 */
const lastSeqCache = new Map<string, { size: number; seq: number }>();

/** lastSeq 尾窗读取上限（字节）：与 HTTP 视图侧 TAIL_WINDOW_BYTES 同量级。 */
export const LAST_SEQ_TAIL_BYTES = 256 * 1024;

/**
 * 尾窗解析：按行反解，返回窗口内最大 seq 的事件（坏行跳过）。
 * lastSeq 慢路径专用；init/read 的全量解析各仍走自身路径。
 */
function parseLast(raw: string): { last: EventRecord | null } {
  let last: EventRecord | null = null;
  const lines = raw.split("\n");
  for (const line of lines) {
    if (line === "") continue;
    try {
      const rec = JSON.parse(line) as EventRecord;
      if (typeof rec.seq === "number" && (last === null || rec.seq > last.seq)) last = rec;
    } catch {
      // 坏行（含窗口起点切进事件中段的残行）：跳过。
    }
  }
  return { last };
}

/** 排队执行一次 append：前一任务失败不阻断后续（失败已由调用方处理）。 */
function enqueueAppend(file: string, task: () => Promise<EventRecord>): Promise<EventRecord> {  const prev = writeChains.get(file) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(task);
  writeChains.set(file, run);
  // 链尾结算后若仍无后继任务入队则清除，避免 Map 随会话累积；若有后继，
  // 链尾已更新为后继任务，不误删。用 then(clear, clear) 而非 finally：
  // run reject 时 finally 派生 promise 无人处理会触发 unhandled rejection。
  const clear = () => {
    if (writeChains.get(file) === run) writeChains.delete(file);
  };
  void run.then(clear, clear);
  return run;
}

export interface AppendInput {
  session_id: string;
  actor: string;
  type: string;
  payload?: unknown;
}

export interface ReadResult {
  events: EventRecord[];
  /** 解析失败的行号列表（1-based 数据行）。 */
  corruptLines: number[];
}

/** 单写者互斥文件：同 room 的 writer 锁名。 */
export const WRITER_LOCK_SUFFIX = ".writer";

export class EventLog {
  private readonly file: string;
  private tornTail = false;

  constructor(file: string) {
    this.file = file;
  }

  /**
   * 扫描现有事件恢复 seq 游标；末尾截断坏行不抛错，标记 tornTail。
   * 必须在首次 append 前调用。共享游标取文件现状与既有游标的较大者，
   * 多实例 init 不失序。
   */
  async init(): Promise<void> {
    if (!existsSync(this.file)) {
      this.tornTail = false;
      return;
    }
    const raw = await readFile(this.file, "utf8");
    let max = 0;
    let torn = false;
    const lines = raw.split("\n").filter((l) => l !== "");
    for (let i = 0; i < lines.length; i++) {
      try {
        const rec = JSON.parse(lines[i]!) as EventRecord;
        if (typeof rec.seq === "number" && rec.seq > max) max = rec.seq;
      } catch {
        // 仅末尾坏行视为 torn tail；中间坏行同样跳过但一并标记。
        torn = true;
        void i;
      }
    }
    const cursor = seqCursors.get(this.file);
    if (cursor === undefined || max > cursor) seqCursors.set(this.file, max);
    this.tornTail = torn;
    // #187：init 全量扫描后同步 lastSeq 读游标（size 与 seq 成对）。
    try {
      lastSeqCache.set(this.file, { size: (await stat(this.file)).size, seq: max });
    } catch {
      // stat 失败：缓存缺位，lastSeq 走尾窗慢路径自愈。
    }
  }

  /** 初始化时是否发现解析失败行。 */
  hasTornTail(): boolean {
    return this.tornTail;
  }

  /** 追加一条事件（副作用记账唯一入口）；返回带 seq 的完整记录。 */
  append(input: AppendInput): Promise<EventRecord> {
    // seq 分配与写文件整体入队：同进程多实例（主控/子代理共享同一 events.jsonl）
    // 并发 append 时串行化；共享游标保证 seq 单调不重复（复核必改 1）。
    return enqueueAppend(this.file, async () => {
      // 队列内串行分配：读游标 → 写文件成功 → 才推进游标。写失败不推进，
      // 后续 append 复用同一 seq，与 torn-tail「坏行不计入游标、重写同 seq」
      // 语义一致，避免失败路径产生 seq 空洞（独立审核确认）。
      const next = (seqCursors.get(this.file) ?? 0) + 1;
      const record: EventRecord = {
        seq: next,
        ts: Date.now(),
        session_id: input.session_id,
        actor: input.actor,
        type: input.type,
        payload: input.payload ?? null,
      };
      await writeFile(this.file, JSON.stringify(record) + "\n", { flag: "a", encoding: "utf8" });
      seqCursors.set(this.file, next);
      // #187：append 路径同步维护 lastSeq 读游标（writeFile 返回即 size 确定——
      // 同进程写经本队列串行化，无并发窗口；stat 失败不影响 append 结果）。
      try {
        lastSeqCache.set(this.file, { size: (await stat(this.file)).size, seq: next });
      } catch {
        // 下次 lastSeq 尾窗自愈。
      }
      return record;
    });
  }

  /**
   * 回放读取（fromSeq 起全量）。坏行跳过并计入 corruptLines；
   * 空文件返回空数组。
   */
  async read(fromSeq = 1): Promise<ReadResult> {
    if (!existsSync(this.file)) return { events: [], corruptLines: [] };
    const raw = await readFile(this.file, "utf8");
    const events: EventRecord[] = [];
    const corruptLines: number[] = [];
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line === "") continue;
      try {
        const rec = JSON.parse(line) as EventRecord;
        if (rec.seq >= fromSeq) events.push(rec);
      } catch {
        corruptLines.push(i + 1);
      }
    }
    return { events, corruptLines };
  }

  /**
   * 末笔 seq（#187 尾窗化：对账游标专用 O(1)~O(尾窗) 读，不逐事件全量）。
   *
   * 快路径：读游标命中（append/init 维护，size 匹配）→ 免内容读；
   * 慢路径：读文件尾部 LAST_SEQ_TAIL_BYTES 窗口（真偏移，非全量进内存），
   * 取窗口内最大 seq——append-only 且 seq 单调，末笔必在尾部；窗口起点切进
   * 某事件中段时该行 JSON 解析失败按坏行跳过（与 torn-tail 同语义）。窗口内
   * 全坏行（窗口 < 一条事件长度，仅理论可能）返回 0：宁低估不误报。
   *
   * 仅读，不推进写游标、不产生写副作用；多读并发安全。
   */
  async lastSeq(): Promise<number> {
    if (!existsSync(this.file)) return 0;
    let size: number;
    try {
      size = (await stat(this.file)).size;
    } catch {
      return 0;
    }
    if (size === 0) return 0;
    const cached = lastSeqCache.get(this.file);
    if (cached !== undefined && cached.size === size) return cached.seq;
    // 慢路径：真偏移尾窗读（IO 与解析都 O(窗口)，非全量进内存）。
    const start = size > LAST_SEQ_TAIL_BYTES ? size - LAST_SEQ_TAIL_BYTES : 0;
    let raw: string;
    if (start === 0) {
      raw = (await readFile(this.file)).toString("utf8");
    } else {
      const fh = await open(this.file, "r");
      try {
        const buf = Buffer.alloc(LAST_SEQ_TAIL_BYTES);
        await fh.read(buf, 0, buf.length, start);
        raw = buf.toString("utf8");
      } finally {
        await fh.close();
      }
    }
    const { last } = parseLast(raw);
    // 游标只缓存确认无疑的值；尾窗降级（last=null）不缓存，下次重扫。
    if (last !== null) lastSeqCache.set(this.file, { size, seq: last.seq });
    return last?.seq ?? 0;
  }

  /** 当前已用事件数（诊断/对账用）。 */
  async count(): Promise<number> {
    if (!existsSync(this.file)) return 0;
    const { size } = await stat(this.file);
    return size === 0 ? 0 : this.read().then((r) => r.events.length);
  }
}
