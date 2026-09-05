// @vitest-environment jsdom
/**
 * 团队 tab 即时性行为测试（issue #186 验收路径）。
 *
 * 验收标准：
 * - 建团成功后（不刷新、不切会话）同会话内「团队」tab 注册（零 RTT 呈现）；
 * - watcher 信号重探测收敛 is_team 真值（幂等，不重复注册）；
 * - 非团队会话不出现；切走会话 tab 注销行为不变。
 *
 * 契约同构（process-avoidance B1）：slots fake 记录 register/dispose 调用，
 * 形状 = index.tsx TEAM_VIEW_SPEC（conversation.view / xiaozhuge-team-view /
 * order 20 / label 团队 / inject(sessionId)）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { makeScopedCtx } from "@deepseek-ai/dsh-api-session-controller/client";
import { TeamCreateButton, TeamViewWatcher, apply, setTeamViewTab } from "../../src/client/index.js";

const SCENARIOS = [
  { name: "oss-maintenance", source: "builtin" as const },
  { name: "research-report", source: "builtin" as const },
];

/** slots fake：记录 register/dispose 调用序（tab 存在性的唯一观测面）。 */
let registerCalls: Array<{ id: string; label?: string }>;
let disposeCount: number;
/** team/status 探测响应（用例驱动 is_team 真值）。 */
let statusResponse: { is_team: boolean };
/** 会话 blank 快照 fake（首轮判定数据源）。 */
let blankById: Record<string, boolean>;
/** 建团 POST 失败注入（状态开关，非 once——scenarios 请求会先于 create）。 */
let failCreate: boolean;

/** 组装宿主 fake ctx 并执行 apply 装配（同构 team-create-ui 测试基建）。 */
function assemble() {
  const slots = {
    inject: () => () => {},
    register: (spec: { id: string; label?: string }) => {
      registerCalls.push({ id: spec.id, label: spec.label });
      return () => {
        disposeCount += 1;
      };
    },
  };
  const sessions = {
    open: () => {},
    openSubagent: () => {},
    subagentAddress: () => undefined,
    refreshSubagents: async () => {},
    list: {
      getSnapshot: () => ({
        ids: Object.keys(blankById),
        byId: Object.fromEntries(
          Object.entries(blankById).map(([id, blank]) => [id, { id, blank }]),
        ),
        current: undefined,
        phase: "ready",
        subagentsByParent: {},
      }),
      subscribe: () => () => {},
    },
    scope: (id: string) =>
      makeScopedCtx(
        { conversation: { send: async () => {} } },
        id,
      ),
  };
  const conversation = {
    input: {
      for: () => ({
        setDraft: () => {},
        state: { getSnapshot: () => ({ draft: "" }) },
      }),
    },
  };
  apply({
    get(name: string) {
      if (name === "slots") return slots;
      if (name === "sessions") return sessions;
      if (name === "conversation") return conversation;
      return undefined;
    },
  } as never);
}

/** 打开浮层并完成一次建团（成功路径）。 */
async function createViaUi(sessionId: string) {
  blankById[sessionId] = true;
  render(createElement(TeamCreateButton, { sessionId }));
  fireEvent.click(screen.getByTitle("选择团队场景并在本会话创建团队"));
  await screen.findByText("research-report");
  fireEvent.click(screen.getByRole("radio", { name: /research-report/ }));
  fireEvent.click(screen.getByRole("button", { name: "在本会话创建团队并发送" }));
}

beforeEach(() => {
  registerCalls = [];
  disposeCount = 0;
  statusResponse = { is_team: false };
  blankById = {};
  failCreate = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/xiaozhuge/team/create")) {
        // 建团 POST 走状态开关（mockImplementationOnce 会先拦到 scenarios 请求）。
        if (failCreate) {
          return Response.json({ ok: false, error: { code: "boom", message: "init 失败" } });
        }
        // 服务端有状态语义：create 落盘成功起，后续 status 探测一律 is_team=true
        //（生产中 create 响应先于任何后续探测，按钮初始探测仍读 false）。
        statusResponse = { is_team: true };
        return Response.json({ ok: true, tier0_prompt: "TIER0" });
      }
      if (u.includes("/api/xiaozhuge/team/status")) {
        return Response.json(statusResponse);
      }
      return Response.json(
        u.includes("/api/xiaozhuge/team/scenarios") ? { scenarios: SCENARIOS } : statusResponse,
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // 模块级协调器状态复位（跨测试隔离）：disposer 残留会让幂等分支短路。
  setTeamViewTab(false);
});

describe("issue #186：团队 tab 即时性（建团信号）", () => {
  it("建团成功（不刷新、不切会话）→ 同会话 tab 立即注册（零 RTT）", async () => {
    assemble();
    await createViaUi("s-a");
    await waitFor(() => {
      expect(registerCalls.some((c) => c.id === "xiaozhuge-team-view")).toBe(true);
    });
    // 呈现零延迟：注册发生在 status 重探测收敛之前也成立（无 fetch 依赖）。
    expect(registerCalls.at(-1)?.label).toBe("团队");
  });

  it("watcher 已挂（线上常态）→ 建团信号零 RTT 注册 + 重探测幂等", async () => {
    assemble();
    // watcher 是恒驻插槽条目，线上在建团前就挂着——先挂再建团。
    render(createElement(TeamViewWatcher, { sessionId: "s-a" }));
    // 首轮探测（is_team=false）已发生且未注册。
    await waitFor(() => {
      expect(statusCalls(fetch)).toBeGreaterThanOrEqual(1);
    });
    await createViaUi("s-a");
    // 零 RTT：信号侧 setTeamViewTab(true) 先于任何重探测生效 → 恰 1 次注册。
    await waitFor(() => expect(registerCalls).toHaveLength(1));
    // 信号 bump 触发重探测 → is_team=true（create 落盘后翻转）→ 幂等 no-op。
    await waitFor(() => {
      expect(statusCalls(fetch)).toBeGreaterThanOrEqual(2);
    });
    expect(registerCalls).toHaveLength(1);
    expect(disposeCount).toBe(0);
  });

  it("非团队会话：is_team=false 不注册；切到团队会话注册；切回非团队注销", async () => {
    assemble();
    statusResponse = { is_team: false };
    const { rerender } = render(createElement(TeamViewWatcher, { sessionId: "s-b" }));
    await waitFor(() => {
      expect(statusCalls(fetch)).toBeGreaterThanOrEqual(1);
    });
    expect(registerCalls.filter((c) => c.id === "xiaozhuge-team-view")).toHaveLength(0);
    // 切到团队会话（sessionId 变化 → effect 重跑）→ 注册。
    statusResponse = { is_team: true };
    rerender(createElement(TeamViewWatcher, { sessionId: "s-t" }));
    await waitFor(() => {
      expect(registerCalls).toHaveLength(1);
    });
    // 切回非团队会话 → 探测 false → 注销（既有行为不回归）。
    statusResponse = { is_team: false };
    rerender(createElement(TeamViewWatcher, { sessionId: "s-b2" }));
    await waitFor(() => {
      expect(disposeCount).toBe(1);
    });
  });

  it("建团失败：无信号 → tab 不注册（不误呈现）", async () => {
    assemble();
    failCreate = true;
    await createViaUi("s-c");
    await screen.findByText(/创建失败/);
    expect(registerCalls.filter((c) => c.id === "xiaozhuge-team-view")).toHaveLength(0);
  });
});

/** status 探测调用计数（观测重探测时机的窗口）。 */
function statusCalls(fetchRef: unknown): number {
  const mock = fetchRef as unknown as { mock: { calls: Array<[RequestInfo | URL, unknown?]> } };
  return mock.mock.calls.filter((c) => String(c[0]).includes("/api/xiaozhuge/team/status")).length;
}
