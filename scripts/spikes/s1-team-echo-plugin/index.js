/**
 * S1 spike 插件（issue #4）：经 cordis 注册原生工具 `team_echo`。
 *
 * 目的：验证「插件通过 ctx.tools.register 注册的工具」在两种会话形态下
 * 均以原生工具呈现且可被模型成功调用：
 *   (a) 根会话；(b) spawned subagent 会话（工作形态）。
 *
 * 工程约定（对照 @wingsky-1/dsh-mcp-manager 的 buildToolDefinition 先例）：
 * 对 @deepseek-ai/* 零运行时值导入，工具定义为手写字面量；参数校验在
 * execute 内手动完成——裸 ToolDefinition 不走 defineTool 的自动校验，
 * 模型漏传参数时 args 为空对象，undefined 字段会触发 lossless-JSON
 * 输出失败（实证撞过：arguments "{}" → "value is not lossless JSON"，
 * 且模型侧看不到可纠正的错误信息）。判定成功标记 XIAOZHUGE_SPIKE_OK。
 */

/** 稳定的 cordis 插件名。 */
export const name = "spike-team-echo";

/** 需要的服务：tools（工具注册表）。 */
export const inject = ["tools"];

/**
 * 挂载 spike：注册 team_echo 并在卸载时精确注销。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主插件上下文。
 */
export function apply(ctx) {
  const dispose = ctx.tools.register({
    name: "team_echo",
    description:
      "Spike verification tool. Echoes the given message back together with a fixed marker string.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Text to echo back." },
      },
      required: ["message"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          echo: { type: "string" },
          marker: { type: "string" },
        },
        required: ["echo", "marker"],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: "text", text: JSON.stringify(value) }];
      },
    },
    async execute(args) {
      // 手动参数校验：给模型可纠正的结构化错误，而不是 lossless 失败。
      if (
        args === null ||
        typeof args !== "object" ||
        Array.isArray(args) ||
        typeof args.message !== "string"
      ) {
        throw new Error(
          'invalid arguments: string field "message" is required, e.g. {"message": "hello"}',
        );
      }
      return { echo: args.message, marker: "XIAOZHUGE_SPIKE_OK" };
    },
  });

  ctx.logger.info("[spike-team-echo] team_echo registered");

  return () => {
    dispose();
    ctx.logger.info("[spike-team-echo] team_echo disposed");
  };
}
