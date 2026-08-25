/**
 * CAS 锁薄适配层（v2.2 定稿 §5；#29 第 C 项：proper-lockfile@4.1.2）。
 *
 * 资源语义：acquireCas/releaseCas/withCasLock/peekLock 的首参为**资源基路径**
 * （不含 .lock 后缀），库以 `${resource}.lock` **目录**（mkdir 原子，跨平台）
 * 为锁形态——rc 前无兼容包袱，直接切换到正确形态。
 *
 * 适配层自管语义（库不提供）：
 * - instance-id 幂等重入：锁目录内 owner.json 记录持有者，acquire 前读比对，
 *   同 id → reentered（P4 场景脚本依赖该判定）；
 * - 孤儿锁保守策略：锁目录存在但无有效 owner（mkdir 与 owner 写入之间崩溃
 *   的产物）默认拒绝，仅显式 takeoverOrphan 时清除接管——**不启用库的
 *   mtime 自动过期抢夺**（其 stale 最小 2000ms 且活锁会被自动 steal，违反
 *   「接管是显式决策」定稿口径）；owner 完好但进程已死的残留同样按冲突拒绝，
 *   死锁恢复仍归巡场对账职责。
 *
 * 库承担：跨平台原子获取/释放、持锁期 mtime 续期与 compromise 检测、
 * signal-exit 进程退出清理。
 */
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lock as plLock, unlock as plUnlock } from "proper-lockfile";
import { LockError } from "./errors.js";
import type { LockInfo } from "./types.js";

/** 锁目录内持有者记录文件名。 */
const OWNER_FILE = "owner.json";

/**
 * 库侧 staleness 参数：适配层不消费 mtime 判定，仅取足够大值避免库的
 * 自动 steal 干扰保守策略；update 续期为 unref 定时器，不阻退出。
 */
const PL_OPTIONS = {
  stale: 24 * 60 * 60 * 1000,
  // 资源基路径是协议约定的名义路径（文件本身不必存在），跳过 realpath 解析。
  realpath: false,
  onCompromised: () => {},
} as const;

function lockDirOf(resourcePath: string): string {
  return `${resourcePath}.lock`;
}

async function readOwner(lockDir: string): Promise<LockInfo | undefined> {
  if (!existsSync(lockDir)) return undefined;
  let raw: string;
  try {
    raw = await readFile(join(lockDir, OWNER_FILE), "utf8");
  } catch {
    return undefined;
  }
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
 * @param resourcePath 资源基路径（如 `<TEAM_HOME>/room`），锁形态为
 *   `${resourcePath}.lock` 目录。
 * @param instanceId 持有者幂等键（约定为主会话 id，跨重启稳定）。
 * @param opts.takeoverOrphan 锁目录存在但无有效 owner（孤儿）时强制清除接管。
 * @throws LockConflictError 已被其他实例持有（含 owner 完好的死进程残留）；
 *   LockError("orphan-lock") 孤儿锁未授权接管。
 */
export async function acquireCas(
  resourcePath: string,
  instanceId: string,
  opts: { takeoverOrphan?: boolean } = {},
): Promise<AcquireResult> {
  const lockDir = lockDirOf(resourcePath);
  if (existsSync(lockDir)) {
    const owner = await readOwner(lockDir);
    if (owner === undefined) {
      if (!opts.takeoverOrphan) {
        throw new LockError(
          "orphan-lock",
          `orphan lock at ${lockDir} (no valid owner); retry with takeoverOrphan to take over`,
        );
      }
      // 显式接管：清除无主锁目录后走正常获取。
      await rm(lockDir, { recursive: true, force: true });
    } else if (owner.holder !== instanceId) {
      throw new LockConflictError(lockDir, owner.holder);
    } else {
      return "reentered";
    }
  }

  try {
    await plLock(resourcePath, PL_OPTIONS);
  } catch {
    // ELOCKED：竞态窗口内被抢先。owner 可能尚未落位，holder 仅作诊断展示。
    const owner = await readOwner(lockDir);
    throw new LockConflictError(lockDir, owner?.holder ?? "(acquiring)");
  }
  await writeOwner(lockDir, instanceId);
  return "acquired";
}

async function writeOwner(lockDir: string, instanceId: string): Promise<void> {
  await writeFile(join(lockDir, OWNER_FILE), JSON.stringify({ holder: instanceId, acquiredAt: Date.now() }), "utf8");
}

/**
 * 释放锁：校验 owner 后删除。孤儿锁（无有效 owner）视为已释放并幂等清除；
 * 非持有者拒绝；锁不存在静默成功。
 * @throws LockConflictError 非持有者。
 */
export async function releaseCas(resourcePath: string, instanceId: string): Promise<void> {
  const lockDir = lockDirOf(resourcePath);
  if (!existsSync(lockDir)) return;
  const owner = await readOwner(lockDir);
  if (owner === undefined) {
    await rm(lockDir, { recursive: true, force: true });
    return;
  }
  if (owner.holder !== instanceId) {
    throw new LockConflictError(lockDir, owner.holder);
  }
  await rm(join(lockDir, OWNER_FILE), { force: true });
  try {
    await plUnlock(resourcePath);
  } catch {
    // unlock 失败（如目录已被动过）：兜底强清，保证释放语义收敛。
    await rm(lockDir, { recursive: true, force: true });
  }
}

/** 持锁执行 fn，结束（含异常）后释放。 */
export async function withCasLock<T>(
  resourcePath: string,
  instanceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await acquireCas(resourcePath, instanceId);
  try {
    return await fn();
  } finally {
    await releaseCas(resourcePath, instanceId);
  }
}

/** 读当前锁信息（诊断用）。 */
export async function peekLock(resourcePath: string): Promise<LockInfo | undefined> {
  return readOwner(lockDirOf(resourcePath));
}

export class LockConflictError extends LockError {
  constructor(lockPath: string, holder: string) {
    super("lock-conflict", `lock ${lockPath} is held by another instance: ${holder}`);
  }
}
