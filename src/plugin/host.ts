/**
 * dsh 插件装配层：把 team_* 工具注册进 cordis tools 服务。
 *
 * #29 第 0 项落地：工具定义与路由面改用 @deepseek-ai 官方类型（仅 import type、
 * 精确 pin 0.1.1-rc.2）——dsh 升级时形状变化获得编译期报警；execute 内仍自行
 * 校验参数并抛稳定 code 错误。TEAM_HOME 按主会话 id 绑定（ADR 0005 宿主绑定层），
 * 一个主会话 = 一个实例根。
 *
 * Wave 1a（#120 v2 计划）：工具面 handler 绑定与 HTTP 视图路由（#100/#102）
 * 同款反查——子代理会话按成员 durable id 反查挂载主控实例，解锁 #86 问题 4
 * 「子代理工具指向空实例」；官方形态偏差理由见 PR 描述（agents.json 是领域
 * 团队注册表，官方 lineage API 回答的是会话谱系问题，AGENTS.md 规则 11）。
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveTeamHome, resolveTeamHomeForView } from "./team-home.js";
import { createHandlers, ToolError, type Handlers } from "./handlers.js";
import { schemas } from "./schemas.js";
import { makeGateRoutes, makeConsoleRoute } from "./gate-console.js";
import { makeLaunchRoutes } from "./team-launch.js";
import { makeOverviewRoute } from "./team-overview.js";

/** 稳定的 cordis 插件名。 */
export const name = "xiaozhuge-team";

/** 需要的服务：tools（工具注册表）+ webServer（Gate Console 与 resolve 端点）。 */
export const inject = ["tools", "webServer"];

/**
 * 从执行上下文解析主会话 id。官方 Agent.id 即会话 id；工具面 agent-required：
 * agentless 调用抛错（参考官方 requireAgent 先例的抛错行为），并携带本项目
 * 内部稳定 code（agent-required）供框架路由与测试断言，不静默挂空实例
 * （复核必改 3；官方先例为裸 Error，code 是内部增强，端到端呈现以 message 为准）。
 */
function sessionIdOf(agent: Agent | undefined): string {
  if (agent?.id === undefined) {
    throw new ToolError("agent-required", "team_* tools require an agent context (exec.agent.id)");
  }
  return agent.id;
}

/**
 * 挂载插件：注册全部 team_* 原生工具。
 * @param ctx 宿主插件上下文（inject 注入 tools 服务）。
 */
export function apply(ctx: {
  tools: { register: (definition: ToolDefinition) => () => void };
  webServer?: { register: (route: WebRoute) => () => void } | null;
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
  get(key: string): unknown;
  /** cordis 事件订阅（webserver/index-inject 用）；缺省形态可无此方法。 */
  on?: (event: "webserver/index-inject", listener: (table: unknown[]) => void) => void;
}): () => void {
  void ctx.get;
  const disposers: Array<() => void> = [];
  // 会话 -> handler 缓存：键 = 调用会话 id（agent.id），值 = 反查所得实例根上的
  // handler 集。不变量：一次会话生命周期内 durableId→实例映射不变（同一会话
  // 永远解析到同一 teamHome，缓存以会话 id 为键成立）；DSH_HOME 运行期变更 /
  // 实例迁移不在支持范围——需重启插件进程重建（复核必改 5）。
  const handlerCache = new Map<string, Handlers>();

  function handlersFor(agent: Agent | undefined): Handlers {
    const sessionId = sessionIdOf(agent);
    let h = handlerCache.get(sessionId);
    if (h === undefined) {
      // Wave 1a：与 HTTP 视图路由同款反查挂载主控实例根（#120 v2 计划 1a）。
      // 主会话直查；子代理（成员 durable id）反查所属主控的 TEAM_HOME，
      // 使工具面与视图面共享同一实例状态。
      const resolution = resolveTeamHomeForView(sessionId);
      h = createHandlers(resolution.teamHome, sessionId);
      // 缓存不变量（复核必改 5）：键 = 调用会话 id，值 = 反查所得实例根上的
      // handler 集；一次会话生命周期内 durableId→实例映射不变。DSH_HOME 运行期
      // 变更 / 实例迁移不在支持范围——需重启插件进程重建。
      //
      // 仅当反查「确实命中」实例时才缓存：主会话自身根有 team.yaml，或子代理
      // 命中某主控实例（membership 非空）。子代理尚未登记（agents.json 无此
      // durable id）时反查回退到会话自身的逻辑根——此时不写缓存，后续调用
      // 每次重新解析；待主控登记后即可命中正确实例（自愈），避免首调空解析
      // 被永久缓存（独立审核发现的中危边界）。
      const selfRoot = resolveTeamHome(sessionId);
      const hit =
        resolution.membership !== null || existsSync(join(selfRoot, "team.yaml"));
      if (hit) handlerCache.set(sessionId, h);
    }
    return h;
  }

  /** ToolDefinition 装配器：name/description/schema + execute 包装。 */
  function define(
    toolName: string,
    description: string,
    schema: { parameters: Record<string, unknown> },
    run: (args: Record<string, unknown>, agent: Agent | undefined) => Promise<unknown>,
  ): void {
    const definition: ToolDefinition = {
      name: toolName,
      description,
      parameters: schema.parameters,
      output: {
        schema: {
          type: "object",
          properties: {
            ok: { type: "boolean", description: "Whether the call succeeded." },
            error: {
              type: "object",
              properties: {
                code: { type: "string" },
                message: { type: "string" },
              },
              required: ["code", "message"],
              additionalProperties: false,
              description: "Present on failure only.",
            },
          },
          required: ["ok"],
          additionalProperties: true,
        },
        render(_args: unknown, value: unknown) {
          return [{ type: "text" as const, text: JSON.stringify(value) }];
        },
      },
      async execute(rawArgs: unknown, exec: ToolRunContext) {
        const args = (rawArgs ?? {}) as Record<string, unknown>;
        const HANDLER_BY_TOOL: Record<string, string> = {
          team_spawn: "spawn",
          team_dispatch: "dispatch",
          team_send: "send",
          team_inbox: "inbox",
          team_ack: "ack",
          team_task_create: "taskCreate",
          team_task_update: "taskUpdate",
          team_task_list: "taskList",
          team_state_get: "stateGet",
          team_state_set: "stateSet",
          team_reconcile: "reconcile",
          team_handoff: "handoff",
        };
        const handlerKey = HANDLER_BY_TOOL[toolName] ?? toolName.replace(/^team_/, "");
        const handlerMap = handlersFor(exec?.agent);
        const handler = (handlerMap as unknown as Record<
          string,
          (a: Record<string, unknown>) => Promise<unknown>
        >)[handlerKey];
        if (handler === undefined) {
          throw new Error(`no handler for ${toolName} (${handlerKey})`);
        }
        const value = await handler(args);
        return { ok: true, ...(value as object) };
      },
    };
    disposers.push(ctx.tools.register(definition));
    ctx.logger.info(`[xiaozhuge] ${toolName} registered`);
  }

  define(
    "team_spawn",
    "Register a spawned subagent into the team registry with its durable subagent id.",
    schemas.spawn,
    (args, agent) => handlersFor(agent).spawn(args),
  );
  define(
    "team_dispatch",
    "Composite dispatch primitive: register the member, assign the task, deliver the assignment envelope in one call; stops at first failure and reports completed steps.",
    schemas.dispatch,
    (args, agent) => handlersFor(agent).dispatch(args),
  );
  define(
    "team_send",
    "Deliver a message into another member's mailbox (atomic, at-least-once).",
    schemas.send,
    (args, agent) => handlersFor(agent).send(args),
  );
  define(
    "team_inbox",
    "Read your unread envelopes; pass envelope_id to claim one specific envelope.",
    schemas.inbox,
    (args, agent) => handlersFor(agent).inbox(args),
  );
  define(
    "team_ack",
    "Acknowledge an envelope after processing it (moves it to processed).",
    schemas.ack,
    (args, agent) => handlersFor(agent).ack(args),
  );
  define(
    "team_task_create",
    "Create a task in the shared ledger; mutex conflicts with running tasks are rejected.",
    schemas.taskCreate,
    (args, agent) => handlersFor(agent).taskCreate(args),
  );
  define(
    "team_task_update",
    "Update a task through the legal status machine; illegal transitions are rejected.",
    schemas.taskUpdate,
    (args, agent) => handlersFor(agent).taskUpdate(args),
  );
  define(
    "team_task_list",
    "List tasks in the shared ledger, optionally filtered by room/status.",
    schemas.taskList,
    (args, agent) => handlersFor(agent).taskList(args),
  );
  define(
    "team_state_get",
    "Read blackboard shards for a room (reserved-stage triplet enforced on write).",
    schemas.stateGet,
    (args, agent) => handlersFor(agent).stateGet(args),
  );
  define(
    "team_state_set",
    "Write your blackboard shard; status must be running|blocked|done.",
    schemas.stateSet,
    (args, agent) => handlersFor(agent).stateSet(args),
  );
  define(
    "team_reconcile",
    "One-call reconciliation view: snapshot summary, member/ledger cross-view (liveness is framework-invisible), orphan members flagged report-only (non-root member with missing or dangling parent), task snapshot, event cursors; scope=audit additionally diffs ledger touched_paths against the recorded workspace tree, metadata only.",
    schemas.reconcile,
    (args, agent) => handlersFor(agent).reconcile(args),
  );
  define(
    "team_handoff",
    "Hand a task to another role; tasks with dod require a per-item receipt array.",
    schemas.handoff,
    (args, agent) => handlersFor(agent).handoff(args),
  );

  // Gate Console + Team 拉起入口路由（webServer 可选注入：headless 形态无此服务）。
  const ws = ctx.webServer;
  if (typeof ws === "object" && ws !== null) {
    // 视图供数解析走 ForView 变体：子会话按成员 durable id 反查所属实例，
    // 使团队 tab 在成员会话页同样可用（#97 问题 3）；纯读路径。
    const teamHomeFor = (sessionId: string) => resolveTeamHomeForView(sessionId).teamHome;
    for (const route of [
      ...makeGateRoutes({ teamHomeFor }),
      makeConsoleRoute(),
      ...makeLaunchRoutes(),
      makeOverviewRoute(teamHomeFor),
    ]) {
      disposers.push(ws.register(route));
    }
    ctx.logger.info("[xiaozhuge] gate console + team launch routes registered");
    // 输入框内「创建团队」按钮由客户端插件（dsh.client，src/client/）经
    // conversation.input.right 官方插槽渲染——不再做宿主页面 DOM 注入。
  }

  ctx.logger.info("[xiaozhuge] all team_* tools registered");

  return () => {
    for (const dispose of disposers) dispose();
  };
}
