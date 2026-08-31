/**
 * 测试替身：@deepseek-ai/dsh-api-session-controller/client（0.1.2 迁移）。
 *
 * 0.1.2 起 dsh-client-runtime 已删，客户端经官方服务方法面（ctx.sessions.scope /
 * scopeOf）寻址会话作用域。该入口打包进宿主 web bundle（__ModuleLoader__ 契约
 * 外壳），node/jsdom 测试环境无法解析真实包——此处按官方语义提供最小替身：
 * - scopeOf(ctx)：读取最近的会话 tag（官方 ISessions.scopeOf 服务方法语义）；
 * - TAG：fake sessions.scope(id) 用它 mint 带 tag 的 ctx。
 * 仅用于 tests/client 行为测试；生产代码路径不受影响（type-only import 擦除）。
 */
export const TAG = "__xzgTestSessionTag";

export function scopeOf(ctx: unknown): string | undefined {
  if (typeof ctx !== "object" || ctx === null) return undefined;
  const tag = (ctx as Record<string, unknown>)[TAG];
  return typeof tag === "string" ? tag : undefined;
}

/** fake sessions.scope(id) 的替身：返回携带会话 tag 的最小 AgentContext。 */
export function makeScopedCtx(
  ctx: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  return { ...ctx, [TAG]: id };
}
