/**
 * 小诸葛 runtime 入口（占位）。
 * G0 阶段将在此导出平台无关纯库：模板校验 / 账本 / 信箱 / 黑板 / 事件记账 / 幂等。
 */

export const VERSION = "0.0.0-dev" as const;

/** 框架保留态三元组——通用归约（着色/阻塞高亮/闭环判定）唯一认可的阶段锚点。 */
export const STAGES = ["running", "blocked", "done"] as const;

export type Stage = (typeof STAGES)[number];

export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}
