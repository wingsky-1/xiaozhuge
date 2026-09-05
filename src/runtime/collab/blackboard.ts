/**
 * 黑板：rooms/<room>/state/<member>.json per-member 分片读写（Q5，#159）。
 * 分片键 = 调用者成员名（stateSet 经 requireSelf 限自身，成员名全局唯一；
 * 多实例同 role 各自独立分片文件，互不覆盖）。设计注记：
 * - Shard.role 字段值保留成员名（字段名"role"为历史债，ADR 0020 记录），
 *   视图层以 shard.role === 成员名为隐式契约，零改动；
 * - 旧归档（纯 role 名分片文件）不迁移：存量会话 member 名 = 纯 role 名时
 *   `state/<member>.json` 与旧路径 `state/<role>.json` 同名天然兼容，读路径
 *   无需后缀剥离回退（后缀剥离会把已死实例分片嫁接到活实例，数据正确性
 *   bug，评审否决）；listShards 原样返回旧文件。
 * 保留态三元组（running/blocked/done）强制为 shard.status；业务子状态放
 * ext 字段仅展示。同 member 并发写属协议违规（单写者约定，与事件流一致）。
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { roomLayout } from "../kernel/paths.js";
import { isReservedStage } from "../kernel/types.js";
import { readJson, writeJsonAtomic } from "../kernel/fs-utils.js";
import { RuntimeError } from "../kernel/errors.js";
import { assertRoomName } from "../kernel/names.js";

/** 黑板分片：保留态 + 自由业务负载（ext 仅展示，不参与归约）。 */
export interface Shard {
  /** 分片键（= 写入者成员名；字段名保留 role 为历史债，见头注）。 */
  role: string;
  status: string;
  /** 业务子状态/任意展示性负载。 */
  ext?: unknown;
  updatedAt: number;
}

/**
 * 分片键白名单（Q5，#159 评审 P2-5）：member 名由主控经 spawn/dispatch 写入，
 * 直接拼文件路径——不含 `/` 等目录分隔符，防路径注入越出 state 目录。
 */
export const SHARD_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

function assertShardKey(key: string): void {
  if (!SHARD_KEY_PATTERN.test(key)) {
    throw new RuntimeError(
      "invalid-shard-key",
      `blackboard shard key must match ${SHARD_KEY_PATTERN}, got: ${key}`,
    );
  }
}

/**
 * 写入成员分片（分片键 = 调用者成员名）。status 必须是保留态三元组之一——
 * 黑板是巡场归约的数据源，非法值会让「阻塞高亮/闭环判定」失去意义，直接拒绝。
 */
export async function setShard(
  teamHome: string,
  room: string,
  member: string,
  shard: Omit<Shard, "role" | "updatedAt"> & { ext?: unknown },
): Promise<Shard> {
  assertShardKey(member);
  // P0-2（#180）：room 入路径前白名单断言（越出 roomsDir 建目录写分片被拒）。
  assertRoomName(room);
  if (!isReservedStage(shard.status)) {
    throw new RuntimeError(
      "invalid-stage",
      `blackboard status must be one of running|blocked|done, got: ${shard.status}`,
    );
  }
  const full: Shard = { ...shard, role: member, status: shard.status, updatedAt: Date.now() };
  await writeJsonAtomic(join(roomLayout(teamHome, room).stateDir, `${member}.json`), full);
  return full;
}

/** 读成员分片（键 = 成员名）；不存在返回 undefined。 */
export async function getShard(
  teamHome: string,
  room: string,
  member: string,
): Promise<Shard | undefined> {
  assertShardKey(member);
  assertRoomName(room);
  return readJson<Shard>(join(roomLayout(teamHome, room).stateDir, `${member}.json`));
}

/** 列出房间全部分片（含旧归档纯 role 名文件，原样返回）。 */
export async function listShards(teamHome: string, room: string): Promise<Shard[]> {
  assertRoomName(room);
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