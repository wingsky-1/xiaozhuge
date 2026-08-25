/**
 * 小诸葛 runtime 入口：平台无关纯库（P2a 数据内核，issue #5）。
 * P2b 起在此追加协作语义层（信箱三段式 / 黑板分片 / 模板与 Role Spec 校验）。
 */

export const VERSION = "0.0.0-dev" as const;

export { RESERVED_STAGES as STAGES, isReservedStage as isStage } from "./runtime/kernel/types.js";

export * from "./runtime/index.js";

// 插件装配导出：dsh loader 经包入口解析 name/inject/apply。
export { name, inject, apply } from "./plugin/host.js";
