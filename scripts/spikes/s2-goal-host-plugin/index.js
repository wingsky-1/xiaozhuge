/**
 * S2 spike host（issue #4）：不退出的最小 Agent 宿主。
 *
 * 照抄 @deepseek-ai/dsh-headless 的 runner 骨架（agents.create → followup），
 * 差异仅在：turn 结束后**不请求进程退出**，把进程留给 goal-round-driver
 * 在 idle 边沿自动注入后续轮次，从而在隔离环境下实测长驻形态的
 * 「idle → 下一轮」节奏与延迟分布。观察由外部脚本轮询 session jsonl 完成。
 *
 * 对 @deepseek-ai/* 零运行时值导入：SessionId 为品牌化字符串类型，
 * 运行时直接传普通字符串（headless runner 的 cast 不产生运行时包装）。
 */

/** 稳定的 cordis 插件名。 */
export const name = "spike-s2-host";

/** 与 headless runner 相同的核心服务面。 */
export const inject = ["agentDefaultModel", "agents", "sessions"];

/**
 * 挂载常驻宿主：创建 agent、投递任务、然后保持存活。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主插件上下文。
 * @param {{task?: string, sessionId?: string}} config 注入配置。
 */
export async function apply(ctx, config = {}) {
  await ctx.get("loader")?.await();
  const agents = ctx.get("agents");
  const defaultModel = ctx.get("agentDefaultModel");
  if (agents === undefined || defaultModel === undefined) {
    ctx.logger.error("[spike-s2-host] required services missing");
    return;
  }
  const selection = defaultModel.currentSelection();
  const { agent } = await agents.create({
    // 已存在会话 id 时为 resume 场景；否则新建。
    sessionId: config.sessionId ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    meta: { cwd: process.cwd() },
    agentOptions: {
      provider: selection.provider,
      model: selection.model,
    },
  });
  ctx.logger.info(`[spike-s2-host] agent ready (session=${agent.session.id} provider=${selection.provider} model=${selection.model})`);
  await agent.whenIdle();
  if (config.task) {
    agent.followup(createUserTextMessage(config.task));
    ctx.logger.info("[spike-s2-host] task queued; staying alive for goal rounds");
  }
  // 不退出：apply 返回后 cordis 树保持挂载，driver 自行驱动后续轮次。
}

/** 构造一条 user-role 文本消息（对齐 dsh-llm createUserMessage 形状）。 */
function createUserTextMessage(text) {
  return {
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}
