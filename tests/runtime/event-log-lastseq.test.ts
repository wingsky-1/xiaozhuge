/**
 * EventLog.lastSeq 尾窗化单测（issue #187 验收证据）。
 *
 * 验收对照（issue #187）：
 * - 长会话（万级事件）不逐事件全量读：>256KB 文件走真偏移尾窗，readFile
 *   调用计数为 0（IO 证据）+ 万级事件耗时上限（性能回归）；
 * - 对账语义不变：lastSeq 与全量 read 回放的末笔 seq 一致（含 torn tail
 *   不高估、跨进程直写不低估）。
 *
 * 独立成文件的理由与 event-log-failure.test.ts 相同：需要对 node:fs/promises
 * 挂 spy 计数（透传不改行为），避免污染 kernel.test.ts 的全局 mock 面。
 */
import { describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// 透传 spy：可 spyOn 计数 fs 调用，不改真实行为；仅本文件使用。
vi.mock("node:fs/promises", { spy: true });
import { EventLog } from "../../src/runtime/kernel/event-log.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "xzg-evlogtail-"));
}

/** 组装一条与 EventRecord 兼容的 jsonl 行。 */
function line(seq: number): string {
  return `${JSON.stringify({ seq, ts: 1, session_id: "s", actor: "a", type: `e${seq}`, payload: null })}\n`;
}

/** readFile 调用计数（lastSeq 的 IO 证据：偏移路径不经过它）。 */
async function readFileCalls(): Promise<number> {
  const fsMod = await import("node:fs/promises");
  const mock = vi.mocked(fsMod.readFile);
  return mock.mock.calls.length;
}

describe("事件流 lastSeq 尾窗化（#187）", () => {
  it("append 后 lastSeq 与 read 回放末笔一致（语义不变）", async () => {
    const file = join(tmpHome(), "events.jsonl");
    const log = new EventLog(file);
    await log.init();
    for (let i = 0; i < 3; i++) await log.append({ session_id: "s", actor: "a", type: `e${i}` });
    const { events } = await log.read();
    expect(await log.lastSeq()).toBe(events[events.length - 1]!.seq);
    expect(await log.lastSeq()).toBe(3);
  });

  it("读游标快路径：append 维护缓存后 lastSeq 零内容读（readFile 0 次）", async () => {
    const file = join(tmpHome(), "events.jsonl");
    const log = new EventLog(file);
    await log.init();
    await log.append({ session_id: "s", actor: "a", type: "e" });
    const before = await readFileCalls();
    expect(await log.lastSeq()).toBe(1);
    expect(await readFileCalls()).toBe(before);
  });

  it("冷启动慢路径：跨进程直写（绕过缓存）后 lastSeq 仍正确", async () => {
    const file = join(tmpHome(), "events.jsonl");
    const log = new EventLog(file);
    await log.init();
    await log.append({ session_id: "s", actor: "a", type: "e1" });
    // 模拟另一进程直写（协议违规场景）：绕过本进程 seqCursors/lastSeqCache。
    appendFileSync(file, line(2));
    // 新实例无任何缓存前态。
    expect(await new EventLog(file).lastSeq()).toBe(2);
  });

  it("torn tail：残行不高估游标（返回最后完整行 seq）", async () => {
    const file = join(tmpHome(), "events.jsonl");
    const log = new EventLog(file);
    await log.init();
    await log.append({ session_id: "s", actor: "a", type: "ok" });
    // 模拟 append 半途 kill：残行 seq=9 但未写完。
    appendFileSync(file, '{"seq":9,"ts":');
    expect(await new EventLog(file).lastSeq()).toBe(1);
  });

  it("万级事件：偏移尾窗路径（readFile 0 次）且耗时上限内（性能回归）", async () => {
    const file = join(tmpHome(), "events.jsonl");
    // 直写 10000 行（≈1.4MB > 256KB 尾窗），绕过写队列加速构造。
    let body = "";
    for (let i = 1; i <= 10000; i++) body += line(i);
    writeFileSync(file, body, "utf8");
    const log = new EventLog(file);
    const before = await readFileCalls();
    const t0 = performance.now();
    const seq = await log.lastSeq();
    const elapsed = performance.now() - t0;
    expect(seq).toBe(10000);
    // IO 证据：>256KB 文件走 open+read 偏移窗口，不经 readFile 全量。
    expect(await readFileCalls()).toBe(before);
    // 耗时上限（宽松值防 CI flake；全量逐行解析路径在此量级显著更慢）。
    expect(elapsed).toBeLessThan(200);
  });

  it("缓存过期自愈：外部追加后同实例 lastSeq 重扫到新值", async () => {
    const file = join(tmpHome(), "events.jsonl");
    const log = new EventLog(file);
    await log.init();
    await log.append({ session_id: "s", actor: "a", type: "e1" });
    expect(await log.lastSeq()).toBe(1);
    appendFileSync(file, line(2));
    expect(await log.lastSeq()).toBe(2);
    expect(await log.lastSeq()).toBe(2);
  });
});
