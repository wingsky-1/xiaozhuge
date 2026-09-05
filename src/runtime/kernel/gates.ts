/**
 * gates/<id>.json 读写：pending → approved/denied 单向（Console 唯一写点的
 * 协议面；本层只提供原语，HTTP 路由属 P5 宿主层）。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GateRecord, GateStatus } from "./types.js";
import { GateError } from "./errors.js";
import { readJson, writeJsonAtomic } from "./fs-utils.js";
import { assertGateId } from "./names.js";

export interface NewGate {
  id: string;
  reason: string;
  requestedBy: string;
}

/** 打开闸口（status=pending）；同 id 已存在即拒（幂等键 = gate id）。 */
export async function openGate(gatesDir: string, input: NewGate): Promise<GateRecord> {
  // P0-2（#180）：gate id 入路径前白名单断言（`${id}.json` 拼文件路径）。
  assertGateId(input.id);
  const file = join(gatesDir, `${input.id}.json`);
  const existing = await readJson<GateRecord>(file);
  if (existing !== undefined) {
    throw new GateError("gate-exists", `gate ${input.id} already exists (${existing.status})`);
  }
  const record: GateRecord = {
    id: input.id,
    status: "pending",
    reason: input.reason,
    requestedBy: input.requestedBy,
    requestedAt: Date.now(),
  };
  await writeJsonAtomic(file, record);
  return record;
}

/** 读单个 gate；不存在返回 undefined。 */
export async function readGate(gatesDir: string, id: string): Promise<GateRecord | undefined> {
  assertGateId(id);
  return readJson<GateRecord>(join(gatesDir, `${id}.json`));
}

/**
 * 裁决：pending → approved/denied 单向；非 pending 即拒（不可逆，无重开）。
 * @param by 裁决主体（Console 审计字段）。
 */
export async function resolveGate(
  gatesDir: string,
  id: string,
  decision: Exclude<GateStatus, "pending">,
  by: string,
): Promise<GateRecord> {
  assertGateId(id);
  const file = join(gatesDir, `${id}.json`);
  const current = await readJson<GateRecord>(file);
  if (current === undefined) {
    throw new GateError("gate-not-found", `gate ${id} does not exist`);
  }
  if (current.status !== "pending") {
    throw new GateError("gate-resolved", `gate ${id} already resolved to ${current.status}`);
  }
  const next: GateRecord = {
    ...current,
    status: decision,
    ...(decision === "approved" || decision === "denied"
      ? { resolvedBy: by, resolvedAt: Date.now() }
      : {}),
  };
  await writeJsonAtomic(file, next);
  return next;
}

/** 枚举全部 gate（跳过损坏文件并如实报告）。 */
export async function listGates(
  gatesDir: string,
): Promise<{ gates: GateRecord[]; corrupt: string[] }> {
  let entries: string[];
  try {
    entries = await readdir(gatesDir);
  } catch {
    return { gates: [], corrupt: [] };
  }
  const gates: GateRecord[] = [];
  const corrupt: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(await readFile(join(gatesDir, entry), "utf8")) as unknown;
      if (isGateRecord(rec)) gates.push(rec);
      else corrupt.push(entry);
    } catch {
      corrupt.push(entry);
    }
  }
  return { gates, corrupt };
}

function isGateRecord(value: unknown): value is GateRecord {
  const v = value as GateRecord;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.id === "string" &&
    (["pending", "approved", "denied"] as const).includes(v.status)
  );
}
