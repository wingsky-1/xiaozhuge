/**
 * EventLog.append 失败路径单测（Wave 1a 多写者护栏的失败语义）。
 *
 * 与 kernel.test.ts 分离：该测试需对 node:fs/promises 注入单次写失败，
 * 若放在 kernel.test.ts 会全局 mock 整个文件的所有 fs 调用（加一层 spy
 * 包装），属测试隔离气味；独立成文件后影响面收敛到此文件。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// 将 node:fs/promises 导出替换为透传 spy（可 mockRejectedValueOnce 注入
// 单次失败），不改真实行为；仅本文件使用。
vi.mock("node:fs/promises", { spy: true });
import { EventLog } from "../../src/runtime/kernel/event-log.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "xzg-evlogfail-"));
}

describe("事件流失败路径", () => {
  it("append 失败不阻断后继 append，且失败不推进 seq 游标", async () => {
    const file = join(tmpHome(), "events.jsonl");
    const log = new EventLog(file);
    await log.init();
    const fsMod = await import("node:fs/promises");
    const spy = vi
      .spyOn(fsMod, "writeFile")
      .mockRejectedValueOnce(new Error("disk full"));
    try {
      // 首个 append 写文件失败 → reject；游标不推进。
      await expect(
        log.append({ session_id: "s", actor: "a", type: "boom" }),
      ).rejects.toThrow("disk full");
      // 后继 append 正常执行，链未被失败任务卡死；失败未推进游标 → seq=1。
      const first = await log.append({ session_id: "s", actor: "a", type: "ok" });
      expect(first.seq).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
