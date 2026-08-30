/**
 * 会话→团队反查索引单测（ADR 0021）。
 *
 * 覆盖：
 * - SessionIndex 基本读写（set/get/remove/close）；
 * - 写面 hook：spawn/dispatch 登记后反查命中；init tier0 主控不登记；
 * - 读面三阶段：直查 → 索引命中 → miss 回扫回填 → 索引再命中；
 * - 负缓存：最近全扫未命中的 id 短窗内不重复全扫；
 * - 索引损坏/不可用 → 降级回落旧全扫（行为正确性不破）；
 * - 索引命中分支保留 team.yaml 守卫（防错检占位实例）。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandlers, memberCaller, rootCaller, type Handlers } from "../../src/plugin/handlers.js";
import { resolveTeamHome, resolveTeamHomeForView } from "../../src/plugin/team-home.js";
import { sessionIndexFor, resetSessionIndex, SessionIndex, INDEX_REL_PATH } from "../../src/plugin/session-index.js";

const SESSION_MASTER = "session-idx-master";
const MEMBER = "coder";
const DUR_X = "dur-idx-1";

let home: string;
let dshHome: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "xzg-idx-"));
  dshHome = join(home, "dsh-home");
  process.env.DSH_HOME = dshHome;
});

afterEach(() => {
  resetSessionIndex();
});

describe("SessionIndex 基本读写", () => {
  it("set/get/remove/close 全链路", () => {
    const idx = sessionIndexFor();
    expect(idx).not.toBeNull();
    idx!.set(DUR_X, join(dshHome, "xiaozhuge", "sessions", SESSION_MASTER), MEMBER);
    expect(idx!.get(DUR_X)).toEqual({
      teamHome: join(dshHome, "xiaozhuge", "sessions", SESSION_MASTER),
      member: MEMBER,
    });
    expect(idx!.get("dur-nope")).toBeUndefined();
    idx!.remove(DUR_X);
    expect(idx!.get(DUR_X)).toBeUndefined();
    idx!.close();
  });

  it("索引文件落盘于 <DSH_HOME>/xiaozhuge/index.sqlite（ADR 0021 落点）", () => {
    sessionIndexFor();
    expect(existsSync(join(dshHome, INDEX_REL_PATH))).toBe(true);
  });

  it("空/超长键拒绝写入，不污染 B-tree", () => {
    const idx = sessionIndexFor()!;
    idx.set("", join(dshHome, "x"), MEMBER);
    idx.set("x".repeat(300), join(dshHome, "x"), MEMBER);
    expect(idx.get("")).toBeUndefined();
    expect(idx.get("x".repeat(300))).toBeUndefined();
  });
});

describe("写面 hook：成员登记 → 索引维护", () => {
  it("spawn tier>0 登记后反查命中；membership 携带成员名", async () => {
    const master = createHandlers(resolveTeamHome(SESSION_MASTER), SESSION_MASTER, rootCaller());
    await master.init({});
    await master.spawn({ member: MEMBER, durable_id: DUR_X, role: MEMBER, tier: 1 });

    const r = resolveTeamHomeForView(DUR_X);
    expect(r.membership).toEqual({ root_session: SESSION_MASTER, member: MEMBER });
    expect(r.teamHome).toBe(resolveTeamHome(SESSION_MASTER));
  });

  it("dispatch step1 登记即入索引（半事务路径也覆盖）", async () => {
    const master = createHandlers(resolveTeamHome(SESSION_MASTER), SESSION_MASTER, rootCaller());
    await master.init({});
    const created = (await master.taskCreate({ title: "t", room: "root" })) as { ok: true; task_id: string };
    await master.dispatch({ member: MEMBER, durable_id: DUR_X, role: MEMBER, tier: 1, task_id: created.task_id });

    expect(resolveTeamHomeForView(DUR_X).membership?.member).toBe(MEMBER);
  });

  it("init tier0 主控不登记索引（直查已覆盖，语义纯净）", async () => {
    const master = createHandlers(resolveTeamHome(SESSION_MASTER), SESSION_MASTER, rootCaller());
    await master.init({});
    const idx = sessionIndexFor()!;
    // init 登记 master（tier=0）不应写入索引；主会话由 team.yaml 直查覆盖。
    expect(idx.get(SESSION_MASTER)).toBeUndefined();
  });
});

describe("读面三阶段", () => {
  it("索引命中：agents.json 被删后仍可反查（证明走索引非全扫）", async () => {
    const masterHome = resolveTeamHome(SESSION_MASTER);
    const master = createHandlers(masterHome, SESSION_MASTER, rootCaller());
    await master.init({});
    await master.spawn({ member: MEMBER, durable_id: DUR_X, role: MEMBER, tier: 1 });

    // 首次反查（索引已由 hook 写入）→ 命中
    expect(resolveTeamHomeForView(DUR_X).membership).toEqual({
      root_session: SESSION_MASTER,
      member: MEMBER,
    });

    // 删除 agents.json（模拟：反查不依赖全扫，索引仍可定位）
    // 注意：agent.json 删除后 scanSessions 不会命中，但索引命中分支有 team.yaml
    // 守卫（team.yaml 在场）→ 返回 membership 仍成立。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { rmSync } = await import("node:fs");
    rmSync(join(masterHome, "agents.json"), { force: true });
    expect(resolveTeamHomeForView(DUR_X).membership).toEqual({
      root_session: SESSION_MASTER,
      member: MEMBER,
    });
  });

  it("miss 回扫回填：手工构造 agents.json（不经 handler）也可自愈入索引", async () => {
    const masterHome = resolveTeamHome(SESSION_MASTER);
    mkdirSync(masterHome, { recursive: true });
    writeFileSync(join(masterHome, "team.yaml"), JSON.stringify({ name: "demo" }));
    writeFileSync(
      join(masterHome, "agents.json"),
      JSON.stringify({ members: { [MEMBER]: { member: MEMBER, durableId: DUR_X } } }),
    );

    // 首次反查：索引无此条目 → 回扫命中 → 回填索引
    const r1 = resolveTeamHomeForView(DUR_X);
    expect(r1.membership).toEqual({ root_session: SESSION_MASTER, member: MEMBER });
    const idx = sessionIndexFor()!;
    expect(idx.get(DUR_X)).toEqual({ teamHome: masterHome, member: MEMBER });
  });

  it("索引命中但实例未初始化（team.yaml 不在）→ 不命中并惰性清条目", async () => {
    const idx = sessionIndexFor()!;
    const masterHome = resolveTeamHome(SESSION_MASTER);
    // 手工把条目写进索引但 team.yaml 不存在（模拟索引残留/占位实例）。
    idx.set(DUR_X, masterHome, MEMBER);
    const r = resolveTeamHomeForView(DUR_X);
    expect(r.membership).toBeNull();
    expect(idx.get(DUR_X)).toBeUndefined();
  });
});

describe("负缓存与降级", () => {
  it("最近全扫未命中的 id：短窗内不重复全扫（二次调用仍回落直查）", async () => {
    // 空环境：sessions 目录不存在
    const r1 = resolveTeamHomeForView("dur-unknown");
    expect(r1.membership).toBeNull();
    const r2 = resolveTeamHomeForView("dur-unknown");
    expect(r2.membership).toBeNull();
    expect(r2.teamHome).toBe(resolveTeamHome("dur-unknown"));
  });

  it("索引损坏 → 禁用并回落旧全扫，正确性不破", async () => {
    // 预置一个损坏的 index.sqlite（非 SQLite 文件）→ 打开/初始化失败 → 禁用索引
    const idxDir = join(dshHome, "xiaozhuge");
    mkdirSync(idxDir, { recursive: true });
    writeFileSync(join(idxDir, "index.sqlite"), "{ this is not a sqlite file }");

    expect(sessionIndexFor()).toBeNull();

    // 回落旧全扫仍正确工作
    const masterHome = resolveTeamHome(SESSION_MASTER);
    mkdirSync(masterHome, { recursive: true });
    writeFileSync(join(masterHome, "team.yaml"), JSON.stringify({ name: "demo" }));
    writeFileSync(
      join(masterHome, "agents.json"),
      JSON.stringify({ members: { [MEMBER]: { member: MEMBER, durableId: DUR_X } } }),
    );
    expect(resolveTeamHomeForView(DUR_X).membership).toEqual({
      root_session: SESSION_MASTER,
      member: MEMBER,
    });
  });
});

describe("会话关闭与隔离", () => {
  it("close 后可重开（新实例）；resetSessionIndex 清空单例表", () => {
    const idx = sessionIndexFor();
    expect(idx).not.toBeNull();
    idx!.close();
    const reopened = sessionIndexFor();
    expect(reopened).not.toBeNull();
    // 引用比较（vitest toBe 对对象做深比较会遍历已关闭实例的 db 属性，
    // 触发 node:sqlite "statement has been finalized"——用显式 Object.is）。
    expect(Object.is(reopened, idx)).toBe(false);
    reopened!.close();
  });

  it("不同 DSH_HOME 隔离：索引互不串扰", () => {
    const idxA = sessionIndexFor(dshHome);
    idxA!.set(DUR_X, "homeA", "ma");
    // 切换 DSH_HOME 到另一目录
    const homeB = join(home, "dsh-home-b");
    process.env.DSH_HOME = homeB;
    const idxB = sessionIndexFor();
    idxB!.set(DUR_X, "homeB", "mb");
    expect(idxA!.get(DUR_X)).toEqual({ teamHome: "homeA", member: "ma" });
    expect(idxB!.get(DUR_X)).toEqual({ teamHome: "homeB", member: "mb" });
  });
});
