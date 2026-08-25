/**
 * 共享任务账本：每任务单文件原子写 + 状态机合法迁移强制（v2.2 定稿 §5）。
 * touched paths / mutexGroups 的分组互斥判定原语供工具层（P3）装配。
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canTransition, type TaskRecord, type TaskStatus } from "./types.js";
import { LedgerError } from "./errors.js";
import { readJson, sweepTmp, writeJsonAtomic } from "./fs-utils.js";

/** 创建任务时的输入（id/rev/时间戳由账本生成）。 */
export interface NewTask {
  title: string;
  room: string;
  assignee?: string;
  touched?: string[];
  mutexGroups?: string[];
  maxRounds?: number;
  dod?: string[];
  baseline?: string;
}

/** 更新任务时的补丁：status 走状态机校验；其余字段浅覆盖。 */
export interface TaskPatch {
  title?: string;
  status?: TaskStatus;
  assignee?: string;
  touched?: string[];
  mutexGroups?: string[];
  rounds?: number;
  maxRounds?: number;
  dod?: string[];
  baseline?: string;
  artifact?: string;
}

export interface UpdateOptions {
  /** 乐观并发：期望的当前 rev，不匹配即拒绝（P3「读-判-写」原子性钩子）。 */
  expectRev?: number;
}

export class Ledger {
  private readonly tasksDir: string;

  constructor(teamHome: string, tasksDir: string) {
    this.tasksDir = tasksDir ?? join(teamHome, "ledger", "tasks");
  }

  /** 创建任务，返回初始记录（status=queued, rev=1）。 */
  async create(input: NewTask): Promise<TaskRecord> {
    const now = Date.now();
    const record: TaskRecord = {
      id: `task-${randomUUID()}`,
      title: input.title,
      status: "queued",
      room: input.room,
      ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
      touched: input.touched ?? [],
      mutexGroups: input.mutexGroups ?? [],
      rounds: 0,
      maxRounds: input.maxRounds ?? 0,
      dod: input.dod ?? [],
      ...(input.baseline !== undefined ? { baseline: input.baseline } : {}),
      rev: 1,
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonAtomic(this.taskFile(record.id), record);
    return record;
  }

  /** 读单个任务；不存在返回 undefined。 */
  async get(id: string): Promise<TaskRecord | undefined> {
    return readJson<TaskRecord>(this.taskFile(id));
  }

  /**
   * 状态机受控更新。status 迁移非法即拒；expectRev 不匹配即拒；
   * rounds 只能单调递增。成功后 rev+1 并原子落盘。
   */
  async update(id: string, patch: TaskPatch, opts: UpdateOptions = {}): Promise<TaskRecord> {
    const current = await this.get(id);
    if (current === undefined) {
      throw new LedgerError("task-not-found", `task ${id} does not exist`);
    }
    if (opts.expectRev !== undefined && opts.expectRev !== current.rev) {
      throw new LedgerError(
        "rev-conflict",
        `task ${id} rev mismatch: expected ${opts.expectRev}, current ${current.rev}`,
      );
    }
    if (patch.status !== undefined && !canTransition(current.status, patch.status)) {
      throw new LedgerError(
        "illegal-transition",
        `task ${id}: illegal transition ${current.status} -> ${patch.status}`,
      );
    }
    if (patch.rounds !== undefined && patch.rounds < current.rounds) {
      throw new LedgerError("rounds-regress", `task ${id}: rounds cannot decrease`);
    }
    const next: TaskRecord = {
      ...current,
      ...patch,
      rev: current.rev + 1,
      updatedAt: Date.now(),
    };
    if (patch.rounds !== undefined && next.maxRounds > 0 && next.rounds > next.maxRounds) {
      throw new LedgerError(
        "rounds-exceeded",
        `task ${id}: rounds ${next.rounds} exceeds max ${next.maxRounds}`,
      );
    }
    await writeJsonAtomic(this.taskFile(id), next);
    return next;
  }

  /** 列出全部任务（跳过临时残片与损坏文件——损坏文件名会出现在结果 warnings）。 */
  async list(): Promise<{ tasks: TaskRecord[]; corrupt: string[] }> {
    if (!existsSync(this.tasksDir)) {
      await mkdir(this.tasksDir, { recursive: true });
    }
    const entries = await readdir(this.tasksDir);
    const tasks: TaskRecord[] = [];
    const corrupt: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(await readFile(join(this.tasksDir, entry), "utf8")) as unknown;
        if (raw === undefined || typeof raw !== "object" || typeof (raw as TaskRecord).id !== "string") {
          corrupt.push(entry);
          continue;
        }
        tasks.push(raw as TaskRecord);
      } catch {
        corrupt.push(entry);
      }
    }
    return { tasks, corrupt };
  }

  private taskFile(id: string): string {
    return join(this.tasksDir, `${id}.json`);
  }

  /** 清扫本目录内的临时残片，返回清除数。 */
  async sweepTmpFiles(): Promise<number> {
    return sweepTmp(this.tasksDir);
  }
}


/**
 * 分组互斥断言原语：同房间 running 任务间，共享任一 mutexGroup 或
 * touched 字面交集非空即冲突（定稿 §6.1「同组互斥才允许 active」）。
 * @returns 冲突对清单；空数组 = 无冲突。
 */
export function findConflicts(
  tasks: TaskRecord[],
): Array<{ a: string; b: string; reason: string }> {
  const active = tasks.filter((t) => t.status === "running");
  const conflicts: Array<{ a: string; b: string; reason: string }> = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!;
      const b = active[j]!;
      if (a.room !== b.room) continue;
      const sharedGroup = a.mutexGroups.find((g) => b.mutexGroups.includes(g));
      if (sharedGroup !== undefined) {
        conflicts.push({ a: a.id, b: b.id, reason: `shared mutex group: ${sharedGroup}` });
        continue;
      }
      const overlap = a.touched.find((p) => b.touched.includes(p));
      if (overlap !== undefined) {
        conflicts.push({ a: a.id, b: b.id, reason: `touched path overlap: ${overlap}` });
      }
    }
  }
  return conflicts;
}
