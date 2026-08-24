/**
 * dsh 插件装配层：把 team_* 工具注册进 cordis tools 服务。
 *
 * S1 结论落地：手写 ToolDefinition 字面量（零 @deepseek-ai 运行时值导入）、
 * execute 内自行校验参数并抛稳定 code 错误；TEAM_HOME 按主会话 id 绑定
 * （ADR 0005 宿主绑定层），一个主会话 = 一个实例根。
 */
import { resolveTeamHome } from "../team-home.js";
import { createHandlers, type Handlers } from "./handlers.js";
import { schemas } from "./schemas.js";
import { makeGateRoutes, makeConsoleRoute } from "./gate-console.js";

/** 稳定的 cordis 插件名。 */
export const name = "xiaozhuge-team";

/** 需要的服务：tools（工具注册表）+ webServer（Gate Console 与 resolve 端点）。 */
export const inject = ["tools", "webServer"];

/** 工具执行上下文中最小必需的 agent 面（结构化鸭子类型，零类型依赖）。 */
interface AgentView {
  session?: { id?: string };
}

/** 从执行上下文解析主会话 id（缺省回退占位，保证工具不炸）。 */
function sessionIdOf(execAgent: AgentView | undefined): string {
  return execAgent?.session?.id ?? "session-unknown";
}

/**
 * 挂载插件：注册全部 team_* 原生工具。
 * @param ctx 宿主插件上下文（inject 注入 tools 服务）。
 */
export function apply(ctx: {
  tools: { register: (definition: unknown) => () => void };
  webServer?: { register: (route: unknown) => () => void } | null;
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
  get(key: string): unknown;
}): () => void {
  void ctx.get;
  const disposers: Array<() => void> = [];
  // 会话 -> handler 缓存：一个主会话一个实例根（TEAM_HOME 绑定）。
  const handlerCache = new Map<string, Handlers>();

  function handlersFor(agent: AgentView | undefined): Handlers {
    const sessionId = sessionIdOf(agent);
    let h = handlerCache.get(sessionId);
    if (h === undefined) {
      h = createHandlers(resolveTeamHome(sessionId), sessionId);
      handlerCache.set(sessionId, h);
    }
    return h;
  }

  /** ToolDefinition 装配器：name/description/schema + execute 包装。 */
  function define(
    toolName: string,
    description: string,
    schema: { parameters: unknown },
    run: (args: Record<string, unknown>, agent: AgentView | undefined) => Promise<unknown>,
  ): void {
    const definition = {
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
      async execute(args: Record<string, unknown>, exec: { agent?: AgentView } | undefined) {
        const HANDLER_BY_TOOL: Record<string, string> = {
          team_init: "init",
          team_spawn: "spawn",
          team_send: "send",
          team_inbox: "inbox",
          team_ack: "ack",
          team_task_create: "taskCreate",
          team_task_update: "taskUpdate",
          team_task_list: "taskList",
          team_state_get: "stateGet",
          team_state_set: "stateSet",
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
        const value = await handler(args ?? {});
        return { ok: true, ...(value as object) };
      },
    };
    disposers.push(ctx.tools.register(definition));
    ctx.logger.info(`[xiaozhuge] ${toolName} registered`);
  }

  define(
    "team_init",
    "Initialize this team instance: create the directory skeleton and take the instance lock. Call once before any other team_* tool.",
    schemas.init,
    (args, agent) => handlersFor(agent).init(args),
  );
  define(
    "team_spawn",
    "Register a spawned subagent into the team registry with its durable subagent id.",
    schemas.spawn,
    (args, agent) => handlersFor(agent).spawn(args),
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
    "team_handoff",
    "Hand a task to another role; tasks with dod require a per-item receipt array.",
    schemas.handoff,
    (args, agent) => handlersFor(agent).handoff(args),
  );

  // Gate Console + resolve 端点（webServer 可选注入：headless 形态无此服务）。
  const ws = ctx.webServer;
  if (typeof ws === "object" && ws !== null) {
    const teamHomeFor = (sessionId: string) => resolveTeamHome(sessionId);
    for (const route of [...makeGateRoutes({ teamHomeFor }), makeConsoleRoute()]) {
      disposers.push(ws.register(route));
    }
    ctx.logger.info("[xiaozhuge] gate console routes registered");
  }

  ctx.logger.info("[xiaozhuge] all team_* tools registered");

  return () => {
    for (const dispose of disposers) dispose();
  };
}
