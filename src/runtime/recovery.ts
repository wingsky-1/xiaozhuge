/**
 * 崩溃恢复原语（v2.2 定稿 §5 幂等与恢复表）：
 * - 信箱 .delivering-* TTL 收割（omo 模式，P2b 三段式的恢复半边）；
 * - 黑板 running 哨兵整分片作废重做；
 * - 原子写临时残片清扫。
 * 收割/作废结果以清单返回，审计事件由调用方追加到事件流。
 */
import { existsSync } from "node:fs";
import { link, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { TMP_PREFIX, readJson } from "./fs-utils.js";
import type { MemberRecord } from "./types.js";

/** 默认投递中 TTL：10 分钟（巡场轮次为分钟级节奏，够宽也够收）。 */
export const DEFAULT_DELIVERING_TTL_MS = 10 * 60_000;

export interface DeliveryRecovery {
  member: string;
  uuid: string;
  /** requeued = 回待读位；dropped = 待读位已存在（processed 防线命中），残片丢弃。 */
  action: "requeued" | "dropped";
}

/**
 * 收割超时的 .delivering-<uuid>.json 残片。
 * 直接 rename 回待读位；目标已存在（EEXIST）即丢弃残片——不做 stat-then-rename
 * （TOCTOU）。已确认过的 uuid 在 processed 位时其待读位不应存在；若存在说明
 * 确认前崩溃，回待读位是正确重投。
 */
export async function recoverDeliveries(
  mailboxDir: string,
  ttlMs = DEFAULT_DELIVERING_TTL_MS,
  now = Date.now(),
): Promise<DeliveryRecovery[]> {
  if (!existsSync(mailboxDir)) return [];
  const result: DeliveryRecovery[] = [];
  for (const member of await readdir(mailboxDir)) {
    const memberDir = join(mailboxDir, member);
    if (!existsSync(memberDir)) continue;
    for (const entry of await readdir(memberDir)) {
      if (!entry.startsWith(".delivering-") || !entry.endsWith(".json")) continue;
      const uuid = entry.slice(".delivering-".length, -".json".length);
      const full = join(memberDir, entry);
      const { mtimeMs } = await stat(full);
      if (now - mtimeMs < ttlMs) continue;
      const target = join(memberDir, `${uuid}.json`);
      // link = 原子 create-if-not-exists：待读位已被占（processed 防线命中）
      // 时 EEXIST，残片丢弃；绝不用 rename（会静默覆盖待读位）。
      try {
        await link(full, target);
        await rm(full);
        result.push({ member, uuid, action: "requeued" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          await rm(full);
          result.push({ member, uuid, action: "dropped" });
        } else {
          throw error;
        }
      }
    }
  }
  return result;
}

export interface SentinelRecovery {
  role: string;
  action: "discarded";
}

/**
 * 黑板 running 哨兵处理：state/<role>.json 含 `"status":"running"` 的分片
 * 整体作废重做（unlink 整文件——半新半旧的脏黑板不可复用）。
 */
export async function discardRunningSentinels(stateDir: string): Promise<SentinelRecovery[]> {
  if (!existsSync(stateDir)) return [];
  const result: SentinelRecovery[] = [];
  for (const entry of await readdir(stateDir)) {
    if (!entry.endsWith(".json")) continue;
    const full = join(stateDir, entry);
    const shard = await readJson<{ status?: string }>(full);
    if (shard?.status !== "running") continue;
    await rm(full);
    result.push({ role: entry.replace(/\.json$/, ""), action: "discarded" });
  }
  return result;
}
