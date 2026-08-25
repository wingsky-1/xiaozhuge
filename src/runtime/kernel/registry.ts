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

  /** 登记或更新成员。 */
  async upsertMember(record: MemberRecord): Promise<void> {
    const reg = await this.read();
    reg.members[record.member] = record;
    await this.write(reg);
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
}
