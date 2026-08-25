/**
 * append-only 事件流（rooms/<room>/events.jsonl，仅运行时单写者）。
 *
 * 单写者约定：同一房间同时只允许一个运行时实例写入（多 room 并行写各自
 * events.jsonl 允许）；双实例并发写同 room 属协议违规，本层不做跨进程仲裁。
 *
 * 崩溃容错：append 半途 kill 会留下截断尾行——初始化扫描与回放读取均跳过
 * 末尾坏行并如实报告（tornTail），不因坏行抛错。
 */
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import type { EventRecord } from "./types.js";

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
  private nextSeq = 1;
  private tornTail = false;

  constructor(file: string) {
    this.file = file;
  }

  /**
   * 扫描现有事件恢复 seq 游标；末尾截断坏行不抛错，标记 tornTail。
   * 必须在首次 append 前调用。
   */
  async init(): Promise<void> {
    if (!existsSync(this.file)) {
      this.nextSeq = 1;
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
    this.nextSeq = max + 1;
    this.tornTail = torn;
  }

  /** 初始化时是否发现解析失败行。 */
  hasTornTail(): boolean {
    return this.tornTail;
  }

  /** 追加一条事件（副作用记账唯一入口）；返回带 seq 的完整记录。 */
  async append(input: AppendInput): Promise<EventRecord> {
    const record: EventRecord = {
      seq: this.nextSeq++,
      ts: Date.now(),
      session_id: input.session_id,
      actor: input.actor,
      type: input.type,
      payload: input.payload ?? null,
    };
    await writeFile(this.file, JSON.stringify(record) + "\n", { flag: "a", encoding: "utf8" });
    return record;
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
