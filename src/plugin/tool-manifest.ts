/**
 * 框架工具面自述（ADR 0015 决策 3，#66）。
 *
 * 建团首条消息尾部追加的「保留段」：仅自述本插件注册的 team_* 工具面，
 * 附显式盲区声明。定位是概率缓解——消除「凭记忆推断工具不存在」的信息缺位
 * 前提；不声称覆盖宿主侧全量工具面（goal/subagent/MCP 不在自述范围），
 * 否则会制造新的权威幻觉（模型反推「清单上没有 = 不存在」）。
 *
 * 本模块是清单的单一事实源：host.ts 的注册名单与本清单经契约测试互锁
 * （tests/plugin/tool-manifest.test.ts），防漂移。
 */

/** 保留段定界符（framework-generated 水印内置；改动 = 协议变更，走增量 ADR）。 */
export const TOOL_MANIFEST_SEPARATOR =
  "\n\n===== framework tool manifest (framework-generated; informational only) =====\n\n";

/** 本插件注册的 team_* 工具自述（名称 → 一句话用途；与 host.ts 注册面一致）。 */
export const TEAM_TOOL_MANIFEST: ReadonlyArray<readonly [string, string]> = [
  ["team_spawn", "登记成员 durable id 入注册表"],
  ["team_dispatch", "注册 → 指派 → 派单复合原语（半事务，失败报告已完成步骤）"],
  ["team_send", "定向信箱投递（含可达性 report-only 标注）"],
  ["team_inbox", "读未读 / 认领指定信封"],
  ["team_ack", "确认信封处理完成"],
  ["team_task_create", "任务账本建账（mutex 预检）"],
  ["team_task_update", "任务状态机流转 / 改派"],
  ["team_task_list", "任务账本查询"],
  ["team_state_get", "黑板读"],
  ["team_state_set", "黑板写（running|blocked|done）"],
  ["team_reconcile", "对账全量视图（scope=audit 为旁路 report-only；overview 含互斥冲突标注）"],
  ["team_handoff", "显式交接（dod 回执核验）"],
];

/** 生成完整保留段文本（不含前导分隔符，调用方拼接）。 */
export function toolManifestText(): string {
  const lines: string[] = [
    "以下工具面清单由框架生成，仅供导航：工具可用性一律以当轮运行时实际注册为准，",
    "本清单不是授权依据，也不得据「清单未列」推断某工具不存在。",
    "",
    "本框架注册的 team_* 工具：",
    ...TEAM_TOOL_MANIFEST.map(([name, desc]) => `- ${name}：${desc}`),
    "",
    "盲区声明：goal 管理、subagent 启动/唤醒、MCP 等宿主侧能力不在本清单范围内，",
    "其存在性请以当轮系统提示词与实际可用工具为准。",
    "启动对账一律先跑 team_reconcile：一次返回成员对照表、任务快照与事件游标。",
  ];
  return lines.join("\n");
}

/** tier0_prompt 组装后追加保留段（幂等：重复追加拒绝，防双份清单漂移）。 */
export function appendToolManifest(tier0Prompt: string): string {
  if (tier0Prompt.includes(TOOL_MANIFEST_SEPARATOR)) {
    throw new Error("double-append: tool manifest section already present");
  }
  return `${tier0Prompt}${TOOL_MANIFEST_SEPARATOR}${toolManifestText()}`;
}
