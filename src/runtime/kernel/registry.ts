/**
 * agents.json 成员注册表读写：父死子活对账的数据源（v2.2 定稿 §4）。
 * 单文件原子写；调用方负责持 room.lock 期间再写（本层不做跨进程仲裁）。
 */
import { join } from "node:path";
import type { MemberRecord, TeamRegistry } from "./types.js";
import { readJson, writeJsonAtomic } from "./fs-utils.js";

export class Registry {
  private readonly file: string;

  constructor(teamHome: string) {
    this.file = join(teamHome, "agents.json");
  }

  /** 读注册表；不存在视为空团队。 */
  async read(): Promise<TeamRegistry> {
    const data = await readJson<TeamRegistry>(this.file);
    return data ?? { members: {} };
  }

  /** 整体原子写。 */
  async write(registry: TeamRegistry): Promise<void> {
    await writeJsonAtomic(this.file, registry);
  }

  /**
   * 登记或更新成员（三态判定，#79）：
   * 1) 同 member + 同 durableId + 同 tier → 幂等成功（仅刷新 lastSeen）；
   *    dispatch 半事务续跑与 init 重入依赖此分支。
   * 2) 异 durableId / 异 tier 且旧记录非 dead → 拒绝（code=member-conflict）：
   *    同名换新 durable id 必须先走接管路径把旧记录标 dead。
   * 3) 旧记录 dead → 允许复位重登记（状态级重建的合法入口）。
   */
  async upsertMember(record: MemberRecord): Promise<"registered" | "idempotent" | "revived"> {
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
      await this.write(reg);
      return "idempotent";
    }
    reg.members[record.member] = record;
    await this.write(reg);
    return existing === undefined ? "registered" : "revived";
  }

  /** 读单个成员。 */
  async getMember(member: string): Promise<MemberRecord | undefined> {
    const reg = await this.read();
    return reg.members[member];
  }

  /** 更新成员状态与 lastSeen；成员不存在即拒。 */
  async setStatus(member: string, status: MemberRecord["status"]): Promise<void> {
    const reg = await this.read();
    const existing = reg.members[member];
    if (existing === undefined) {
      throw new Error(`member ${member} is not registered`);
    }
    existing.status = status;
    existing.lastSeen = Date.now();
    await this.write(reg);
  }

  /** 存活成员清单（status !== dead），供 reattach 对账。 */
  async liveMembers(): Promise<MemberRecord[]> {
    const reg = await this.read();
    return Object.values(reg.members).filter((m) => m.status !== "dead");
  }

  /**
   * 心跳刷新（#97，ADR 0016）：白名单工具调用成功路径上刷新成员 lastSeen。
   * 约束：必须由调用方在 handler await 链内串行执行——writeJsonAtomic 是
   * 整文件原子覆盖，裸异步 RMW 会与下一请求交错丢失成员记录（终稿硬伤
   * 修正①；同进程多实例写者串行化另见 ADR 0017）。成员不存在时静默跳过：
   * 非登记成员无账可刷，可达性校验由调用方 handler 负责。
   */
  async touchMember(member: string): Promise<void> {
    const reg = await this.read();
    const existing = reg.members[member];
    if (existing === undefined) return;
    existing.lastSeen = Date.now();
    await this.write(reg);
  }
}
