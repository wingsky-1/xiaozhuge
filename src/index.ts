/**
 * 小诸葛 runtime 入口：平台无关纯库（P2a 数据内核，issue #5）。
 * P2b 起在此追加协作语义层（信箱三段式 / 黑板分片 / 模板与 Role Spec 校验）。
 */

export const VERSION = "0.0.0-dev" as const;

/** 框架保留态三元组——通用归约（着色/阻塞高亮/闭环判定）唯一认可的阶段锚点。 */
export const STAGES = ["running", "blocked", "done"] as const;

export type Stage = (typeof STAGES)[number];

export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

export * from "./runtime/index.js";
