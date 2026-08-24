/**
 * 黑板：rooms/<room>/state/<role>.json per-role 分片读写。
 * 保留态三元组（running/blocked/done）强制为 shard.status；业务子状态放
 * ext 字段仅展示。同 role 并发写属协议违规（单写者约定，与事件流一致）；
 * 跨 role 分片天然路径隔离。
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { roomLayout } from "./paths.js";
import { isReservedStage } from "./types.js";
import { readJson, writeJsonAtomic } from "./fs-utils.js";
import { RuntimeError } from "./errors.js";

/** 黑板分片：保留态 + 自由业务负载（ext 仅展示，不参与归约）。 */
export interface Shard {
  role: string;
  status: string;
  /** 业务子状态/任意展示性负载。 */
  ext?: unknown;
  updatedAt: number;
}

/**
 * 写入角色分片。status 必须是保留态三元组之一——黑板是巡场归约的数据源，
 * 非法值会让「阻塞高亮/闭环判定」失去意义，直接拒绝。
 */
export async function setShard(
  teamHome: string,
  room: string,
  role: string,
  shard: Omit<Shard, "role" | "updatedAt"> & { ext?: unknown },
): Promise<Shard> {
  if (!isReservedStage(shard.status)) {
    throw new RuntimeError(
      "invalid-stage",
      `blackboard status must be one of running|blocked|done, got: ${shard.status}`,
    );
  }
  const full: Shard = { ...shard, role, status: shard.status, updatedAt: Date.now() };
  await writeJsonAtomic(join(roomLayout(teamHome, room).stateDir, `${role}.json`), full);
  return full;
}

/** 读角色分片；不存在返回 undefined。 */
export async function getShard(
  teamHome: string,
  room: string,
  role: string,
): Promise<Shard | undefined> {
  return readJson<Shard>(join(roomLayout(teamHome, room).stateDir, `${role}.json`));
}

/** 列出房间全部分片。 */
export async function listShards(teamHome: string, room: string): Promise<Shard[]> {
  const stateDir = roomLayout(teamHome, room).stateDir;
  if (!existsSync(stateDir)) return [];
  const shards: Shard[] = [];
  for (const entry of await readdir(stateDir)) {
    if (!entry.endsWith(".json")) continue;
    const shard = await readJson<Shard>(join(stateDir, entry));
    if (shard) shards.push(shard);
  }
  return shards.sort((a, b) => a.role.localeCompare(b.role));
}
