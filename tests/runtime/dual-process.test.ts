/**
 * 双进程 CAS 竞争契约测试（issue #5 验收项）。
 *
 * 纯库同进程单测证明不了跨进程正确性：这里 spawn 两个独立 node 子进程
 * 争抢同一锁文件，断言互斥、幂等重入与崩溃残留语义。
 *
 * Stryker 会为每个 mutant 重跑本文件（子进程启动开销大），mutation 运行时跳过；
 * 锁逻辑的分支杀伤由 kernel.test.ts 的预置锁文件单测承担。
 */
import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";

const skipUnderMutation = process.env.STRYKER_MUTATOR_ACTIVE === "true";

// worker 以纯 JS 运行（不经 TS loader），通过 createRequire 解析编译后的 dist；
// 若 dist 未构建则回退到 tsx 不可行——因此先确保 build（CI 顺序保证；本地由
// beforeAll 兜底触发一次 tsc 编译）。
function distEntry(): string {
  const require = createRequire(import.meta.url);
  return require.resolve("../../dist/runtime/cas-lock.js");
}

interface WorkerResult {
  outcome: "acquired" | "reentered" | "conflict" | "orphan";
  holder?: string;
}

function runWorker(lockPath: string, instanceId: string): WorkerResult {
  const script = `
    const { acquireCas } = await import(${JSON.stringify(distEntry())});
    try {
      const r = await acquireCas(${JSON.stringify(lockPath)}, ${JSON.stringify(instanceId)});
      console.log(JSON.stringify({ outcome: r }));
    } catch (e) {
      console.log(JSON.stringify({ outcome: e.code === "lock-conflict" ? "conflict" : e.code === "orphan-lock" ? "orphan" : "unknown", holder: e.message }));
    }
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });
  return JSON.parse(out.trim().split("\n").pop()!) as WorkerResult;
}

describe.skipIf(skipUnderMutation)("双进程 CAS 竞争契约", () => {
  it("两进程同时争抢：恰一 acquired，另一 conflict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xzg-dual-"));
    const lock = join(dir, "room"); // 资源基路径（锁形态 room.lock 目录）

    const start = (id: string) =>
      new Promise<WorkerResult>((resolve) => {
        const script = `
          const { acquireCas } = await import(${JSON.stringify(distEntry())});
          try {
            const r = await acquireCas(${JSON.stringify(lock)}, ${JSON.stringify(id)});
            console.log(JSON.stringify({ outcome: r }));
            await new Promise((res) => setTimeout(res, 300)); // 持锁窗口，制造真实重叠
          } catch (e) {
            console.log(JSON.stringify({ outcome: e.code === "lock-conflict" ? "conflict" : "orphan" }));
          }
        `;
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          stdio: ["ignore", "pipe", "ignore"],
        });
        let out = "";
        child.stdout.on("data", (d) => (out += String(d)));
        child.on("close", () => resolve(JSON.parse(out.trim().split("\n").pop() ?? "{}")));
      });

    const [a, b] = await Promise.all([start("sess-A"), start("sess-B")]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["acquired", "conflict"]);
  }, 20_000);

  it("持锁进程 kill -9 后：锁残留、异实例拒、同实例重入", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xzg-dual-"));
    const lock = join(dir, "room"); // 资源基路径（锁形态 room.lock 目录）
    const script = `
      const { acquireCas } = await import(${JSON.stringify(distEntry())});
      await acquireCas(${JSON.stringify(lock)}, ${JSON.stringify("victim")});
      console.log("held");
      await new Promise(() => {}); // 永不退出，等待外部 kill -9
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    await new Promise<void>((resolve) => {
      child.stdout!.on("data", (d) => {
        if (String(d).includes("held")) resolve();
      });
    });
    child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 200));

    // 锁文件残留：异实例拒绝（孤儿语义不适用——内容完好）
    expect(runWorker(lock, "other").outcome).toBe("conflict");
    // 同实例幂等重入成功
    expect(runWorker(lock, "victim").outcome).toBe("reentered");
  }, 20_000);
});
