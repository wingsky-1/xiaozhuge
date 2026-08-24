/**
 * S4 spike 探针（issue #4）：验证「宿主端插件能否观测/解析用户消息流」。
 *
 * 双打点对照：
 * - `agent/inbox/inserted`：消息入 inbox 时同步 emit（实时观测点）；
 * - `session/event`：事件落账后 post-commit emit（firehose，含 user/message）。
 * 两个钩子各追加一条记录到 S4_PROBE_FILE（jsonl），驱动脚本据此断言：
 * role/source/全文可得、双钩子均可达、时序关系成立。
 *
 * nonce 凭证 PoC：user 消息含 GATE-NONCE-OK-7F3A 时写 S4_NONCE_FILE，
 * 证明「以 user-role 消息为人意凭证 → 插件执行放行动作」链路可行
 * （真·对话批准双通道的最小形态）。
 */
import { appendFileSync, writeFileSync } from "node:fs";

/** 稳定的 cordis 插件名。 */
export const name = "spike-s4-probe";

const NONCE = "GATE-NONCE-OK-7F3A";

/** 提取 UserMessage 的纯文本与元信息。 */
function summarize(message) {
  const text = (message.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ");
  return {
    role: message.role,
    source: message.source ?? null,
    textHead: text.slice(0, 160),
    textLen: text.length,
    hasNonce: text.includes(NONCE),
  };
}

/**
 * 挂载探针。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主插件上下文。
 */
export function apply(ctx) {
  const probeFile = process.env.S4_PROBE_FILE ?? "/tmp/s4-probe.jsonl";
  const nonceFile = process.env.S4_NONCE_FILE ?? "/tmp/s4-nonce-approved";
  let nonceHandled = false;

  const record = (hook, message, extra = {}) => {
    try {
      appendFileSync(
        probeFile,
        JSON.stringify({ hook, t: Date.now(), ...summarize(message), ...extra }) + "\n",
      );
    } catch (error) {
      ctx.logger.warn(`[spike-s4-probe] record failed: ${error?.message ?? error}`);
    }
  };

  // 实时观测点：同步 emit，审批等待窗内也不死区。
  ctx.on("agent/inbox/inserted", ({ message }) => {
    if (message?.role !== "user") return;
    record("agent/inbox/inserted", message);
    if (!nonceHandled && summarize(message).hasNonce) {
      nonceHandled = true;
      try {
        writeFileSync(nonceFile, String(Date.now()));
        record("action", message, { action: "gate-approved-by-nonce" });
      } catch (error) {
        ctx.logger.warn(`[spike-s4-probe] nonce action failed: ${error?.message ?? error}`);
      }
    }
  });

  // 落账观测点：post-commit firehose。
  ctx.on("session/event", (session, event) => {
    if (event?.type !== "user/message") return;
    record("session/event", event.data?.message ?? event.data ?? {});
  });

  ctx.logger.info("[spike-s4-probe] probes installed");
}
