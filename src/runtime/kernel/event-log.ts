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
import { readFile, stat, writeFile } from "node:fs/promises";
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

/** 排队执行一次 append：前一任务失败不阻断后续（失败已由调用方处理）。 */
function enqueueAppend(file: string, task: () => Promise<EventRecord>): Promise<EventRecord> {
  const prev = writeChains.get(file) ?? Promise.resolve();
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
      const next = (seqCursors.get(this.file) ?? 0) + 1;
      seqCursors.set(this.file, next);
      const record: EventRecord = {
        seq: next,
        ts: Date.now(),
        session_id: input.session_id,
        actor: input.actor,
        type: input.type,
        payload: input.payload ?? null,
      };
      await writeFile(this.file, JSON.stringify(record) + "\n", { flag: "a", encoding: "utf8" });
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

  /** 当前已用事件数（诊断/对账用）。 */
  async count(): Promise<number> {
    if (!existsSync(this.file)) return 0;
    const { size } = await stat(this.file);
    return size === 0 ? 0 : this.read().then((r) => r.events.length);
  }
}
