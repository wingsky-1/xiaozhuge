/**
 * agents.json 成员注册表读写：父死子活对账的数据源（v2.2 定稿 §4）。
 * 单文件原子写；进程内写链串行化（ADR 0017 口径：同进程多实例写者——
 * 主控与子代理共享同一 TEAM_HOME——以 agents.json 文件绝对路径为键的
 * Promise 链互斥排队，杜绝基于旧快照的交错覆盖丢记录；跨进程并发写仍属
 * 协议违规，本层不做跨进程仲裁，单写者约定见 docs 11§5）。
 */
import { join } from "node:path";
import type { MemberRecord, TeamRegistry } from "./types.js";
import { readJson, writeJsonAtomic } from "./fs-utils.js";

/**
 * 进程内写队列：以 agents.json 文件绝对路径为键的 Promise 链。
 * 参考 event-log.ts enqueueAppend 同款模式（ADR 0016 修订，P0-1，#180）：
 * 整个 read-modify-write 入队，前序任务失败不阻断后续。
 */
const writeChains = new Map<string, Promise<unknown>>();

/** 排队执行一次写任务；链尾结算后无后继则清除，避免 Map 随会话累积。 */
function enqueueWrite<T>(file: string, task: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(file) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(task);
  writeChains.set(file, run);
  // then(clear, clear) 而非 finally：run reject 时 finally 派生 promise 无人
  // 处理会触发 unhandled rejection（与 event-log 同款理由）。
  const clear = () => {
    if (writeChains.get(file) === run) writeChains.delete(file);
  };
  void run.then(clear, clear);
  return run;
}

export class Registry {
  private readonly file: string;

  constructor(teamHome: string) {
    this.file = join(teamHome, "agents.json");
  }

  /**
   * 读注册表；不存在视为空团队。
   * 队列外裸读：writeJsonAtomic 是临时文件 + rename 原子发布，读侧永远
   * 只见完整旧版或完整新版，不见半态；RMW 的读在队列任务内执行（见下）。
   */
  async read(): Promise<TeamRegistry> {
    const data = await readJson<TeamRegistry>(this.file);
    return data ?? { members: {} };
  }

  /** 整体原子写（入队：与 RMW 任务共用同一写链，串行互斥）。 */
  write(registry: TeamRegistry): Promise<void> {
    return enqueueWrite(this.file, () => writeJsonAtomic(this.file, registry));
  }

  /**
   * 登记或更新成员（三态判定，#79）：
   * 1) 同 member + 同 durableId + 同 tier → 幂等成功（仅刷新 lastSeen）；
   *    dispatch 半事务续跑与 init 重入依赖此分支。
   * 2) 异 durableId / 异 tier 且旧记录非 dead → 拒绝（code=member-conflict）：
   *    同名换新 durable id 必须先走接管路径把旧记录标 dead。
   * 3) 旧记录 dead → 允许复位重登记（状态级重建的合法入口）。
   * 整个 RMW 入队：read 在队列任务内执行，读到的必是前序写完成后的
   * 最新注册表（P0-1，#180——修并发交错覆盖丢成员记录）。
   */
  async upsertMember(record: MemberRecord): Promise<"registered" | "idempotent" | "revived"> {
    return enqueueWrite(this.file, async () => {
      const reg = await this.read();
      const existing = reg.members[record.member];
      if (existing !== undefined && existing.status !== "dead") {
        if (existing.durableId !== record.durableId || existing.tier !== record.tier) {
          const err = new Error(
            `member ${record.member} already registered as ${existing.durableId} (tier ${existing.tier}); ` +
              "mark the old record dead before re-registering with a different durable id",
          );
          (err as Error & { code?: string }).code = "member-conflict";
          throw err;
        }
        existing.lastSeen = Date.now();
        await writeJsonAtomic(this.file, reg);
        return "idempotent";
      }
      reg.members[record.member] = record;
      await writeJsonAtomic(this.file, reg);
      return existing === undefined ? "registered" : "revived";
    });
  }

  /** 读单个成员。 */
  async getMember(member: string): Promise<MemberRecord | undefined> {
    const reg = await this.read();
    return reg.members[member];
  }

  /** 更新成员状态与 lastSeen；成员不存在即拒（RMW 入队）。 */
  async setStatus(member: string, status: MemberRecord["status"]): Promise<void> {
    await enqueueWrite(this.file, async () => {
      const reg = await this.read();
      const existing = reg.members[member];
      if (existing === undefined) {
        throw new Error(`member ${member} is not registered`);
      }
      existing.status = status;
      existing.lastSeen = Date.now();
      await writeJsonAtomic(this.file, reg);
    });
  }

  /** 存活成员清单（status !== dead），供 reattach 对账。 */
  async liveMembers(): Promise<MemberRecord[]> {
    const reg = await this.read();
    return Object.values(reg.members).filter((m) => m.status !== "dead");
  }

  /**
   * 心跳刷新（#97，ADR 0016）：白名单工具调用成功路径上刷新成员 lastSeen。
   * RMW 入队：并发 touchMember 交错不再基于旧快照覆盖（P0-1，#180——
   * ADR 0016 暂缓文件锁时期暴露的写窗口在此收敛）。成员不存在时静默跳过：
   * 非登记成员无账可刷，可达性校验由调用方 handler 负责。
   */
  async touchMember(member: string): Promise<void> {
    await enqueueWrite(this.file, async () => {
      const reg = await this.read();
      const existing = reg.members[member];
      if (existing === undefined) return;
      existing.lastSeen = Date.now();
      await writeJsonAtomic(this.file, reg);
    });
  }
}
