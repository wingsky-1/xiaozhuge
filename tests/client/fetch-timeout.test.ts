/**
 * 客户端 fetch 超时封装单测（ADR 0021；对齐 dsh-plugin-hub #287）。
 *
 * - 常量契约：CLIENT_FETCH_TIMEOUT_MS = 10_000；
 * - 慢响应在超时窗内 TimeoutError abort 不悬挂（半开连接兜底主断言）；
 * - 快响应透传不误杀（注入超时信号未触发）；
 * - caller 自带 signal 时透传不兜底（避免双取消竞争，#111 同款语义）；
 * - AbortSignal.timeout 缺失（iOS 旧版）回退 setTimeout+AbortController。
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchTimeout, CLIENT_FETCH_TIMEOUT_MS } from "../../src/client/fetch.js";

const fastResponse = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
  // 恢复被测试临时覆盖的 AbortSignal.timeout
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((AbortSignal as any).__origTimeout !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (AbortSignal as any).timeout = (AbortSignal as any).__origTimeout;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (AbortSignal as any).__origTimeout;
  }
});

describe("fetchTimeout 常量与接线", () => {
  it("默认超时常量 10s（与 mcp-manager api() #111 先例对齐）", () => {
    expect(CLIENT_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("快响应原样透传，不误杀", async () => {
    const spy = vi.fn(async () => fastResponse());
    vi.stubGlobal("fetch", spy);
    const out = await fetchTimeout("/api/xiaozhuge/team/status?session=s1");
    expect(await out.json()).toEqual({ ok: true });
    // 注入的超时信号已接线但正常路径未 abort
    const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeDefined();
    expect(init?.signal?.aborted).toBe(false);
  });

  it("慢响应（永不 settle）在注入的短超时窗内 TimeoutError abort 不悬挂", async () => {
    // 半开连接模拟：请求永不 settle，仅在 signal abort 时以 reason reject
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    });
    const t0 = Date.now();
    await expect(
      fetchTimeout("/api/xiaozhuge/team/status", undefined, 50),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("caller 自带 signal 时透传不注入兜底（防双取消竞争）", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("caller-cancel", "AbortError"));
    const spy = vi.fn(async (_u: string, init?: RequestInit) => {
      throw init?.signal?.reason;
    });
    vi.stubGlobal("fetch", spy);
    await expect(
      fetchTimeout("/api/xiaozhuge/team/status", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBe(controller.signal);
  });
});

describe("AbortSignal.timeout 缺失回退（iOS 旧版）", () => {
  it("无 AbortSignal.timeout 时用 setTimeout+AbortController，超时窗内同样 abort", async () => {
    // 模拟旧环境：临时移除 AbortSignal.timeout
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orig = (AbortSignal as any).timeout;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (AbortSignal as any).__origTimeout = orig;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (AbortSignal as any).timeout = undefined;

    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    });
    await expect(fetchTimeout("/api/x", undefined, 50)).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("回退路径下快响应仍正常透传", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orig = (AbortSignal as any).timeout;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (AbortSignal as any).__origTimeout = orig;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (AbortSignal as any).timeout = undefined;

    vi.stubGlobal("fetch", async () => fastResponse());
    const out = await fetchTimeout("/api/xiaozhuge/team/scenarios", undefined, 50);
    expect(out.status).toBe(200);
  });
});
