/**
 * 框架工具面自述（ADR 0015 决策 3，#66；ADR 0023 英文重构）。
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
  ["team_spawn", "Register member durable ID in registry"],
  ["team_dispatch", "Atomic dispatch primitive: register, assign, and deliver envelope"],
  ["team_send", "Direct mailbox delivery with reachability annotation"],
  ["team_inbox", "Read unread envelopes or claim specific envelope"],
  ["team_ack", "Acknowledge and archive processed envelope"],
  ["team_task_create", "Create task in shared ledger with mutex check"],
  ["team_task_update", "Transition task status machine or reassign"],
  ["team_task_list", "Query task ledger snapshot"],
  ["team_state_get", "Read blackboard shards for a room"],
  ["team_state_set", "Write blackboard shard (running|blocked|done)"],
  ["team_reconcile", "Unified reconciliation view: members, tasks, cursors, mutexes"],
  ["team_handoff", "Explicit task handoff with DoD receipt verification"],
];

/** 生成完整保留段文本（不含前导分隔符，调用方拼接）。 */
export function toolManifestText(): string {
  const lines: string[] = [
    "The following framework tool manifest is generated for navigation guidance only.",
    "Tool availability is determined strictly by runtime registration for the current turn.",
    "This list is informational; never infer that an unlisted tool does not exist.",
    "",
    "Framework-registered team_* tools:",
    ...TEAM_TOOL_MANIFEST.map(([name, desc]) => `- ${name}: ${desc}`),
    "",
    "Blindspot disclaimer: Host capabilities (goal management, subagent spawn/wake, MCP, shell, fs) are outside this manifest; verify their presence via system prompt and current runtime tools.",
    "Always run team_reconcile first for startup reconciliation: returns member cross-view, task snapshot, and event cursors in a single call.",
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
