// @vitest-environment jsdom
/**
 * #163 Q1 子代理页「返回团队」导航 client 行为测试。
 *
 * - rootSessionOf：openSession 三级链 parent 必须 = 团队根 id（tier0 durableId）；
 *   master 未登记（旧实例兼容态）回落当前会话 id；overview 未达回落 fallback。
 * - classifyTeamRole：身份三态判定（root/member/none），纯函数可测（评审 P1-4）。
 * - TeamBackNavEntry：member 会话显示「返回团队」按钮，点击调 sessions.open(root_session)；
 *   root/none 隐藏；fetch 失败静默降级不白屏。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { apply, setTeamViewTab, TeamViewWatcher, TeamCreateButton } from "../../src/client/index.js";
import {
  TeamBackNavEntry,
  bindSessionsService,
  classifyTeamRole,
  gateConsoleUrl,
  openSession,
  rootSessionOf,
  type MemberNodeView,
  type TeamOverview,
  type TeamStatusLike,
} from "../../src/client/team-view.js";

function status(isTeam: boolean, membership?: { root_session: string; member: string } | null): TeamStatusLike {
  return { is_team: isTeam, ...(membership !== undefined ? { membership } : {}) };
}

function overviewWith(tier0DurableId: string | null): TeamOverview {
  return {
    isTeam: true,
    masterRegistered: tier0DurableId !== null,
    members: [
      {
        member: "master",
        tier: 0,
        parent: null,
        durableId: tier0DurableId,
        registryStatus: "running",
        tone: "running",
        currentActivity: null,
        lastSeen: 1,
      },
    ],
    rooms: [],
  };
}

describe("rootSessionOf：团队根会话 id 推导（#163 P1-1）", () => {
  it("overview 未达（null）→ 回落当前会话 id", () => {
    expect(rootSessionOf(null, "s-current")).toBe("s-current");
  });

  it("tier0 在册 → 返回其 durableId（跨成员跳转 catalog parent 正确）", () => {
    expect(rootSessionOf(overviewWith("s-root"), "s-child")).toBe("s-root");
  });

  it("master 未登记（旧实例）→ 回落当前会话 id", () => {
    expect(rootSessionOf(overviewWith(null), "s-current")).toBe("s-current");
  });
});

describe("classifyTeamRole：身份三态判定（#163 O1）", () => {
  it("member：is_team=true 且经反查命中实例（root_session 非空）", () => {
    expect(classifyTeamRole(status(true, { root_session: "s-root", member: "coder" }))).toBe("member");
  });

  it("root：is_team=true 但非成员（主控自身）", () => {
    expect(classifyTeamRole(status(true, null))).toBe("root");
    expect(classifyTeamRole(status(true))).toBe("root");
  });

  it("none：非团队会话", () => {
    expect(classifyTeamRole(status(false))).toBe("none");
    expect(classifyTeamRole(status(false, null))).toBe("none");
  });
});

describe("TeamBackNavEntry：子代理页「返回团队」入口（#163）", () => {
  let openCalls: string[];

  /** 绑定 sessions 服务：记录 open 调用（导航目标断言）。 */
  function bindSessions() {
    bindSessionsService({
      open: (id: string) => {
        openCalls.push(id);
      },
      openSubagent: () => {},
      subagentAddress: () => undefined,
      refreshSubagents: async () => {},
    });
  }

  beforeEach(() => {
    openCalls = [];
    bindSessions();
  });
  afterEach(() => {
    bindSessionsService(null);
    cleanup();
    vi.unstubAllGlobals();
  });

  it("member：显示「返回团队」按钮，点击 open(root_session)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(status(true, { root_session: "s-root", member: "coder" })),
      ),
    );
    render(createElement(TeamBackNavEntry, { sessionId: "s-child" }));
    const btn = await screen.findByRole("button", { name: "返回团队" });
    fireEvent.click(btn);
    await waitFor(() => expect(openCalls).toEqual(["s-root"]));
  });

  it("root 会话：隐藏（团队 tab 已在 tab 栏，不重复入口）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(status(true, null))));
    render(createElement(TeamBackNavEntry, { sessionId: "s-root" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "返回团队" })).toBeNull();
    });
  });

  it("none 会话：隐藏", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(status(false))));
    render(createElement(TeamBackNavEntry, { sessionId: "s-other" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "返回团队" })).toBeNull();
    });
  });

  it("fetch 失败：静默降级为隐藏（不白屏、不抛错）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    render(createElement(TeamBackNavEntry, { sessionId: "s-child" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "返回团队" })).toBeNull();
    });
  });

  it("sessions 服务未绑定：点击不抛错（fail-loud 兜底）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(status(true, { root_session: "s-root", member: "coder" }))));
    bindSessionsService(null);
    render(createElement(TeamBackNavEntry, { sessionId: "s-child" }));
    const btn = await screen.findByRole("button", { name: "返回团队" });
    expect(() => fireEvent.click(btn)).not.toThrow();
  });
});

describe("openSession：成员回放三级跳转链（issue #169 PR-A）", () => {
  let openCalls: string[];
  let openSubagentCalls: unknown[];
  let refreshCalls: string[];
  let addressOf: (id: string) => { parentSessionId: string; childSessionId: string; mode: "one-shot" | "continuable" } | undefined;

  function memberView(durableId: string | null): MemberNodeView {
    return {
      member: "coder",
      tier: 1,
      parent: "master",
      durableId,
      registryStatus: "spawned",
      tone: "idle",
      currentActivity: null,
      lastSeen: Date.now(),
    };
  }

  function bindSessions() {
    bindSessionsService({
      open: (id: string) => {
        openCalls.push(id);
      },
      openSubagent: (address: unknown) => {
        openSubagentCalls.push(address);
      },
      subagentAddress: (id: string) => addressOf(id),
      refreshSubagents: async (parentId: string) => {
        refreshCalls.push(parentId);
      },
    });
  }

  beforeEach(() => {
    openCalls = [];
    openSubagentCalls = [];
    refreshCalls = [];
    addressOf = () => undefined;
    bindSessions();
  });
  afterEach(() => {
    bindSessionsService(null);
  });

  it("已打开过的会话：subagentAddress 命中 → openSubagent(address)，不 refresh", async () => {
    addressOf = (id) =>
      id === "s-child"
        ? { parentSessionId: "s-root", childSessionId: "s-child", mode: "continuable" }
        : undefined;
    const child = memberView("s-child");
    await openSession(child, "s-root");
    expect(refreshCalls).toEqual([]);
    expect(openSubagentCalls).toEqual([
      { parentSessionId: "s-root", childSessionId: "s-child", mode: "continuable" },
    ]);
    expect(openCalls).toEqual([]);
  });

  it("未打开过的会话：subagentAddress miss → refreshSubagents(parent) → 降级 open(childId)（PR-A 根因修正）", async () => {
    // 宿主语义：subagentAddress 只查「已保留地址」，未打开过的会话恒 miss；
    // refreshSubagents 刷 catalog 但不写 addresses——二级重试后依旧 miss。
    const child = memberView("s-child");
    await openSession(child, "s-root");
    expect(refreshCalls).toEqual(["s-root"]);
    expect(openSubagentCalls).toEqual([]);
    // 修复点：降级目标是 open(childId)，宿主 select 内部 navigationAddress
    // 会从已刷新 catalog 反查成功；原实现 open(parent) 在团队页等于原地跳转。
    expect(openCalls).toEqual(["s-child"]);
  });

  it("refreshSubagents 抛错：降级 open(childId) 不崩 UI（fail-loud 兜底）", async () => {
    bindSessionsService({
      open: (id: string) => {
        openCalls.push(id);
      },
      openSubagent: () => {},
      subagentAddress: () => undefined,
      refreshSubagents: async () => {
        throw new Error("catalog unavailable");
      },
    });
    const child = memberView("s-child");
    await expect(openSession(child, "s-root")).resolves.toBeUndefined();
    expect(openCalls).toEqual(["s-child"]);
  });

  it("durableId 缺失：静默返回不抛错", async () => {
    const child = memberView(null);
    await expect(openSession(child, "s-root")).resolves.toBeUndefined();
    expect(openCalls).toEqual([]);
  });
});

describe("apply：插槽注册与 D-1 inject 数据通道（#163 O1 / #179 D-1）", () => {
  /** 记录 register spec（含 inject 通道）与组件，供执行断言。 */
  function applyWithCapturedSlots(tabs: Array<{ slot: string; spec: { name: string; id: string; inject?: (id: string) => object }; component: unknown }>) {
    const slots = {
      inject: (slot: string, callback: () => unknown) => {
        void callback();
      },
      register: (spec: { name: string; id: string; inject?: (id: string) => object }, component: unknown) => {
        tabs.push({ slot: spec.name, spec, component });
        return () => {};
      },
    };
    apply({
      get(name: string) {
        if (name === "slots") return slots;
        return undefined;
      },
    } as never);
    return slots;
  }

  it("apply 后各插槽条目注册且 inject(sessionId) 返回会话 id props（D-1 契约）", () => {
    const tabs: Array<{ slot: string; spec: { name: string; id: string; inject?: (id: string) => object }; component: unknown }> = [];
    applyWithCapturedSlots(tabs);
    // 恒驻 input.right 两条目（建团按钮 + 团队 tab 协调器）+ header.actions「返回团队」。
    const byId = new Map(tabs.map((t) => [t.spec.id, t]));
    expect(byId.get("xiaozhuge-team-create")?.component).toBe(TeamCreateButton);
    expect(byId.get("xiaozhuge-team-view-watcher")?.component).toBe(TeamViewWatcher);
    expect(byId.get("xiaozhuge-team-back-nav")?.component).toBe(TeamBackNavEntry);
    // D-1：0.1.2-rc.1 owner(InputZone) 数据面移除后，sessionId 经 inject 通道注入。
    for (const entry of tabs) {
      expect(entry.spec.inject?.("s-child")).toEqual({ sessionId: "s-child" });
    }
  });

  it("setTeamViewTab(true) 经 slotsService 注册 conversation.view（TEAM_VIEW_SPEC），inject 返回会话 id", () => {
    const tabs: Array<{ slot: string; spec: { name: string; id: string; inject?: (id: string) => object }; component: unknown }> = [];
    applyWithCapturedSlots(tabs);
    setTeamViewTab(true);
    const view = tabs.find((t) => t.spec.id === "xiaozhuge-team-view");
    expect(view).toBeDefined();
    expect(view?.slot).toBe("conversation.view");
    expect(view?.spec.inject?.("s-root")).toEqual({ sessionId: "s-root" });
    setTeamViewTab(false); // 幂等注销清理
  });
});

describe("TeamViewWatcher：团队 tab 存在性协调器（issue #68/#97）", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setTeamViewTab(false);
  });

  it("is_team=true → 经 fetchTimeout 探测成功（fetch 路径与响应消费正确）", async () => {
    const fetchSpy = vi.fn(async () => Response.json(status(true)));
    vi.stubGlobal("fetch", fetchSpy);
    render(createElement(TeamViewWatcher, { sessionId: "s-root" }));
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toContain("/api/xiaozhuge/team/status?session=s-root");
    // 响应消费路径不抛错（注册经 setTeamViewTab；slots 未绑定时静默，不白屏）
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is_team=false → 不抛错、无 UI 残留", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(status(false))));
    render(createElement(TeamViewWatcher, { sessionId: "s-other" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("fetch 失败 → 静默保持现状（不误删已呈现 tab、不白屏）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    render(createElement(TeamViewWatcher, { sessionId: "s-root" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("sessionId 为空 → 直接注销 tab 不 fetch", async () => {
    const fetchSpy = vi.fn(async () => Response.json(status(false)));
    vi.stubGlobal("fetch", fetchSpy);
    render(createElement(TeamViewWatcher, { sessionId: "" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("gateConsoleUrl：Gate 待办入口（#195 U0-c）", () => {
  it("session 直达参数经 encodeURIComponent 拼装", () => {
    expect(gateConsoleUrl("abc-123")).toBe("/xiaozhuge/console?session=abc-123");
    expect(gateConsoleUrl("id/with&special")).toBe("/xiaozhuge/console?session=id%2Fwith%26special");
  });
});
