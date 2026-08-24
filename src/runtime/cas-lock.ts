/**
 * CAS 锁（room.lock + instance-id 幂等键，v2.2 定稿 §5）。
 *
 * 语义：
 * - acquire：`open(path, 'wx')` 原子创建；已存在时读 holder——
 *   同 instanceId → 幂等重入成功；异 holder → Conflict；
 *   空/坏内容 → 孤儿锁（acquire 到写 holder 之间崩溃的产物），默认拒绝，
 *   仅当显式 `takeoverOrphan` 时接管（接管是显式决策，不做自动过期）。
 * - release：re-read 校验 holder 后 unlink；非持有者拒绝。
 * - 死锁恢复归巡场对账职责（人工/规程删残留锁或显式 takeover），本层无 TTL。
 */
import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { LockError } from "./errors.js";
import type { LockInfo } from "./types.js";

async function readLock(lockPath: string): Promise<LockInfo | undefined> {
  if (!existsSync(lockPath)) return undefined;
  const raw = await readFile(lockPath, "utf8");
  if (raw.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof parsed.holder !== "string") return undefined;
    return { holder: parsed.holder, acquiredAt: parsed.acquiredAt ?? 0 };
  } catch {
    return undefined;
  }
}

export type AcquireResult = "acquired" | "reentered";

/**
 * 原子获取 CAS 锁。
 * @param lockPath 锁文件路径（如 room.lock）。
 * @param instanceId 持有者幂等键（约定为主会话 id，跨重启稳定）。
 * @param opts.takeoverOrphan 锁文件存在但为空/坏内容（孤儿锁）时强制接管。
 * @throws LockConflictError 已被其他实例持有；LockError 其他失败。
 */
export async function acquireCas(
  lockPath: string,
  instanceId: string,
  opts: { takeoverOrphan?: boolean } = {},
): Promise<AcquireResult> {
  // 快路径：幂等重入与孤儿判定都先读一次，避免无谓的创建冲突。
  if (existsSync(lockPath)) {
    const existing = await readLock(lockPath);
    if (existing === undefined) {
      if (!opts.takeoverOrphan) {
        throw new LockError(
          "orphan-lock",
          `orphan lock at ${lockPath} (empty or corrupt); retry with takeoverOrphan to take over`,
        );
      }
      return writeHolder(lockPath, instanceId, "acquired");
    }
    if (existing.holder === instanceId) return "reentered";
    throw new LockConflictError(lockPath, existing.holder);
  }

  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // 竞态窗口内被他人抢先：走慢路径复判。
      return acquireCas(lockPath, instanceId, opts);
    }
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ holder: instanceId, acquiredAt: Date.now() }), "utf8");
  } finally {
    await handle.close();
  }
  return "acquired";
}

async function writeHolder(lockPath: string, instanceId: string, result: AcquireResult): Promise<AcquireResult> {
  // 接管孤儿：unlink + wx 重建，保证内容完整原子落位（中间空窗极短且
  // 孤儿本身即无主状态，无并发保护对象）。
  await unlink(lockPath);
  const handle = await open(lockPath, "wx");
  try {
    await handle.writeFile(JSON.stringify({ holder: instanceId, acquiredAt: Date.now() }), "utf8");
  } finally {
    await handle.close();
  }
  void result;
  return "acquired";
}

/**
 * 释放锁：re-read 校验 holder 后删除。
 * @throws LockError 非持有者；锁不存在时静默成功（幂等清理）。
 */
export async function releaseCas(lockPath: string, instanceId: string): Promise<void> {
  const existing = await readLock(lockPath);
  if (existing === undefined) {
    // 不存在（含孤儿空文件）：视为已释放。
    if (existsSync(lockPath)) await unlink(lockPath);
    return;
  }
  if (existing.holder !== instanceId) {
    throw new LockConflictError(lockPath, existing.holder);
  }
  await unlink(lockPath);
}

/** 持锁执行 fn，结束（含异常）后释放。 */
export async function withCasLock<T>(
  lockPath: string,
  instanceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await acquireCas(lockPath, instanceId);
  try {
    return await fn();
  } finally {
    await releaseCas(lockPath, instanceId);
  }
}

/** 读当前锁信息（诊断用）。 */
export async function peekLock(lockPath: string): Promise<LockInfo | undefined> {
  return readLock(lockPath);
}

export class LockConflictError extends LockError {
  constructor(lockPath: string, holder: string) {
    super("lock-conflict", `lock ${lockPath} is held by another instance: ${holder}`);
  }
}
