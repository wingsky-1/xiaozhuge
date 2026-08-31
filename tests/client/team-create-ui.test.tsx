// @vitest-environment jsdom
/**
 * 建团浮层 client 行为测试（issue 80 / 81 / 82 验收路径）。
 *
 * - issue 80：单选受控——初始勾选 = 将提交值；切换后提交值跟随；
 * - issue 82：弹窗不预选——未显式选择时创建按钮禁用且有提示文案；
 * - issue 81：建团成功后经 conversation.input 门面清空目标会话草稿，
 *   投递失败保留草稿，清空落在快照的目标会话而非当前会话。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
// 0.1.2：dsh-client-runtime 已删；scopeOf 经官方服务方法面替身寻址
// （vitest.config.ts alias → tests/client/stubs/session-controller-client.ts）。
import { scopeOf, makeScopedCtx } from "@deepseek-ai/dsh-api-session-controller/client";
import {
  TeamCreateButton,
  ScenarioPicker,
  scenarioKey,
  apply,
  type InputZone,
} from "../../src/client/index.js";

/** 场景清单 fixture（字典序与线上一致：首项 ≠ 用户意图项）。 */
const SCENARIOS = [
  { name: "oss-maintenance", source: "builtin" as const },
  { name: "research-report", source: "builtin" as const },
];

function pickerProps(selected: Parameters<typeof ScenarioPicker>[0]["selected"]) {
  return {
    scenarios: SCENARIOS,
    busy: false,
    error: null,
    selected,
    onSelect: (entry: (typeof SCENARIOS)[number]) => {
      current = entry;
      rerenderPicker(entry);
    },
    onGo: () => {},
    onClose: () => {},
  };
}

let current: (typeof SCENARIOS)[number] | null = null;
/** 当前挂载的 rerender 句柄（模拟父组件 state 驱动的受控重渲染）。 */
let rerenderPicker: (entry: (typeof SCENARIOS)[number] | null) => void = () => {};

function mountPicker(initial: (typeof SCENARIOS)[number] | null) {
  const { rerender } = render(createElement(ScenarioPicker, pickerProps(initial)));
  rerenderPicker = (entry) => rerender(createElement(ScenarioPicker, pickerProps(entry)));
}

beforeEach(() => {
  current = null;
});
afterEach(() => {
  cleanup();
});

describe("issue 82：场景弹窗不预选", () => {
  it("弹窗打开时无任何预选，创建按钮禁用且显示提示文案", () => {
    mountPicker(null);
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    for (const radio of radios) expect(radio.checked).toBe(false);
    const go = screen.getByRole("button", { name: "在本会话创建团队并发送" });
    expect(go).toHaveProperty("disabled", true);
    expect(screen.getByText("请先选择一个团队场景")).toBeTruthy();
  });
});

describe("issue 80：受控单选——显示勾选 = 提交值", () => {
  it("显式点击后勾选项与 selected state（提交值）严格一致", () => {
    mountPicker(null);
    const research = screen.getByRole("radio", { name: /research-report/ }) as HTMLInputElement;
    fireEvent.click(research);
    // 重渲染后断言：research-report 勾选、selected 同步为同一 entry。
    const checked = (screen.getAllByRole("radio") as HTMLInputElement[]).filter((r) => r.checked);
    expect(checked).toHaveLength(1);
    expect(checked[0].value).toBe(scenarioKey({ source: "builtin", name: "research-report" }));
    expect(current).toEqual({ name: "research-report", source: "builtin" });
  });

  it("切换选择后勾选与提交值跟随移动，不会双勾选", () => {
    mountPicker(null);
    fireEvent.click(screen.getByRole("radio", { name: /research-report/ }));
    fireEvent.click(screen.getByRole("radio", { name: /oss-maintenance/ }));
    const checked = (screen.getAllByRole("radio") as HTMLInputElement[]).filter((r) => r.checked);
    expect(checked).toHaveLength(1);
    expect(checked[0].value).toBe(scenarioKey({ source: "builtin", name: "oss-maintenance" }));
    expect(current).toEqual({ name: "oss-maintenance", source: "builtin" });
    // 选择后提示文案消失、按钮激活。
    expect(screen.queryByText("请先选择一个团队场景")).toBeNull();
    expect(screen.getByRole("button", { name: "在本会话创建团队并发送" })).toHaveProperty("disabled", false);
  });
});

describe("issue 81：建团成功后清空目标会话草稿", () => {
  /** conversation 门面 fake：记录 resolver 收到的 ctx tag 与 setDraft 调用。 */
  let draftCalls: Array<{ sessionTag: string | undefined; text: string }>;
  /** scope 门面 fake：conversation.send 投递记录 + 失败注入。 */
  let sendCalls: Array<{ sessionTag: string | undefined; text: string }>;
  let promptResult: { ok: true } | { ok: false; error: { message: string } };

  /** 组装宿主 fake ctx 并执行 apply 装配（注入 sessions/conversation 句柄）。 */
  function assemble() {
    const slots = {
      inject: () => () => {},
      register: () => () => {},
    };
    // fake ISessions 服务方法面（0.1.2 官方形状）：scope(id) mint 带 tag 的
    // AgentContext（scoped conversation.send 记录投递；失败走 reject）；
    // list.getSnapshot() 供 loadScenarios 读 cwd。
    const sessions = {
      open: () => {},
      openSubagent: () => {},
      subagentAddress: () => undefined,
      refreshSubagents: async () => {},
      list: {
        getSnapshot: () => ({ byId: {} }),
      },
      scope: (id: string) =>
        makeScopedCtx(
          {
            conversation: {
              send: async (text: string) => {
                sendCalls.push({ sessionTag: id, text });
                if (promptResult.ok !== true) {
                  throw new Error(promptResult.error.message);
                }
              },
            },
          },
          id,
        ),
    };
    const conversation = {
      input: {
        for: (actx: Parameters<typeof scopeOf>[0]) => ({
          setDraft: (text: string) => {
            draftCalls.push({ sessionTag: scopeOf(actx), text });
          },
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
      // 0.1.2 起经 ctx.sessions.scope 服务方法边界寻址；真实 scope 生命周期
      // 由宿主集成兜底——此处以最小结构面通过类型即可。
    } as never);
  }

  /** 打开浮层并完成一次指定场景的建团流程（终态等待由用例自行断言）。 */
  async function createViaUi(sessionId: string, scenario: string) {
    const zone: InputZone = {
      session: { blank: true, sessionId } as InputZone["session"],
      // InputState 官方必填字段（draft/draftRev/imageIds/phase/occurrences/queue）。
      input: {
        draft: "修复 80 81 82",
        draftRev: 0,
        imageIds: [],
        phase: "plain",
        occurrences: [],
        queue: [],
      },
    };
    render(createElement(TeamCreateButton, zone));
    fireEvent.click(screen.getByTitle("选择团队场景并在本会话创建团队"));
    await screen.findByText("research-report");
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(scenario) }));
    fireEvent.click(screen.getByRole("button", { name: "在本会话创建团队并发送" }));
  }

  beforeEach(() => {
    draftCalls = [];
    sendCalls = [];
    promptResult = { ok: true };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) =>
        Response.json(
          String(url).includes("/api/xiaozhuge/team/scenarios")
            ? { scenarios: SCENARIOS }
            : { ok: true, tier0_prompt: "TIER0" },
        ),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("成功路径：setDraft('') 落在投递目标会话（tag = 快照的 targetSession）", async () => {
    assemble();
    await createViaUi("session-target", "research-report");
    await waitFor(() => expect(draftCalls.length).toBeGreaterThan(0));
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].sessionTag).toBe("session-target");
    expect(sendCalls[0].text).toContain("【我的任务】修复 80 81 82");
    expect(draftCalls.at(-1)).toEqual({ sessionTag: "session-target", text: "" });
  });

  it("失败路径：规程投递失败不清草稿（setDraft 不被调用）", async () => {
    assemble();
    promptResult = { ok: false, error: { message: "boom" } };
    await createViaUi("session-target", "research-report");
    // 失败文案出现且草稿写路径零调用。
    await waitFor(() => expect(screen.getByText(/创建失败/)).toBeTruthy());
    expect(draftCalls).toHaveLength(0);
  });
});
