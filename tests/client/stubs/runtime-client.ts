/**
 * 测试替身：@deepseek-ai/dsh-client-runtime/client。
 *
 * 该入口是 window.__ModuleLoader__ 契约外壳 bundle（仅宿主浏览器可加载），
 * node/jsdom 测试环境无法解析。此处按官方语义提供最小实现：
 * - createScope(ctx, key)：mint 携带会话 tag 的作用域句柄（官方为 cordis
 *   tagged ctx + dispatch filter；替身以标记字段承载同一寻址语义）；
 * - scopeOf(ctx)：读取最近的会话 tag。
 * 仅用于 tests/client 行为测试；生产代码路径不受影响。
 */
export interface StubAgentScopeHandle {
  fiber: { dispose(): Promise<void> };
  ctx: Record<string, unknown>;
}

const TAG = "__xzgTestSessionTag";

export function createScope(
  ctx: Record<string, unknown>,
  key: string,
): StubAgentScopeHandle {
  const tagged: Record<string, unknown> = { ...ctx, [TAG]: key };
  return {
    fiber: { dispose: async () => {} },
    ctx: tagged,
  };
}

export function scopeOf(ctx: unknown): string | undefined {
  if (typeof ctx !== "object" || ctx === null) return undefined;
  const tag = (ctx as Record<string, unknown>)[TAG];
  return typeof tag === "string" ? tag : undefined;
}
