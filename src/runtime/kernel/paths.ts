/**
 * 目录协议路径解析（v2.2 定稿 §3 布局）。
 *
 * teamHome 即实例根：ADR 0005（#13 冻结口径）下由宿主绑定层解析为
 * `<DSH_HOME>/xiaozhuge/sessions/<主会话id>`，本库不关心其绝对形态，
 * 只按协议拼出各文件/目录的落点。
 */
import { join } from "node:path";

export interface RoomLayout {
  dir: string;
  /** append-only 事件流（仅运行时单写者）。 */
  eventsFile: string;
  /** 黑板 per-role 分片目录。 */
  stateDir: string;
  /** 简报目录。 */
  briefDir: string;
}

export interface Layout {
  teamHome: string;
  teamYaml: string;
  agentsJson: string;
  /** CAS 锁资源基路径（不含 .lock 后缀）；锁形态为 room.lock 目录（proper-lockfile）。 */
  roomLock: string;
  ledgerTasksDir: string;
  roomsDir: string;
  mailboxDir: string;
  gatesDir: string;
  archiveDir: string;
}

/** 解析实例根下的顶层协议路径。teamHome 即实例根，不再追加 <instance-id> 层。 */
export function layout(teamHome: string): Layout {
  return {
    teamHome,
    teamYaml: join(teamHome, "team.yaml"),
    agentsJson: join(teamHome, "agents.json"),
    roomLock: join(teamHome, "room"),
    ledgerTasksDir: join(teamHome, "ledger", "tasks"),
    roomsDir: join(teamHome, "rooms"),
    mailboxDir: join(teamHome, "mailbox"),
    gatesDir: join(teamHome, "gates"),
    archiveDir: join(teamHome, "archive"),
  };
}

/** 解析单个房间的布局。 */
export function roomLayout(teamHome: string, room: string): RoomLayout {
  const dir = join(layout(teamHome).roomsDir, room);
  return {
    dir,
    eventsFile: join(dir, "events.jsonl"),
    stateDir: join(dir, "state"),
    briefDir: join(dir, "brief"),
  };
}

/** 信箱成员目录。 */
export function memberMailboxDir(teamHome: string, member: string): string {
  return join(layout(teamHome).mailboxDir, member);
}
