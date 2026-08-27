/**
 * 投递/唤醒配对矩阵等协议常量（issue #6「配对协议常量」）。
 * 文档性单一事实源：运行时逻辑不消费，供测试与规程文本引用断言。
 */
/** 信箱三段位。 */
export const MAILBOX_SEGMENTS = ["unread", "delivering", "processed"] as const;

export { TEMPLATE_SOURCES, STALE_THRESHOLD_MS } from "./types.js";

/**
 * re-export 口径（#97 起，ADR 0016）：本文件是文档性单一事实源——运行时
 * 判断一律消费 types.js 协议常量区原件；此处仅按需 re-export 供测试与
 * 规程文本统一引用点。STALE_THRESHOLD_MS 的定义与取值锚点见 types.js。
 */

/**
 * 「投递 + 唤醒」配对矩阵：谁投递、谁负责唤醒、被唤醒后先做什么。
 * 定稿 §2.1 注与 §4：工具只把「该唤醒了」的事实可靠放进账本/信箱，
 * send_message 唤醒由 Tier-0 巡场循环完成。
 */
export const DELIVERY_WAKEUP_MATRIX = {
  /** 发送方运行时负责信封原子落盘。 */
  deliveryOwner: "sender",
  /** 仅 Tier-0 巡场负责唤醒（subagent 不能自发开新 turn）。 */
  wakeupOwner: "tier0-watchman",
  /** 被唤醒后的第一步：收割自己信箱再继续。 */
  onWakeup: "harvest-mailbox-first",
  /** 投递确认语义：at-least-once，消费者按信封 id 幂等处理。 */
  deliveryAckSemantics: "at-least-once",
} as const;

/** Gate 单向流转（P2a gates 原语的协议面声明）。 */
export const GATE_FLOW = { from: "pending", to: ["approved", "denied"] } as const;
