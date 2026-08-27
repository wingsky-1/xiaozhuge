/**
 * team_* 工具参数 JSON Schema（手写字面量）。
 *
 * S1 结论：裸 ToolDefinition 不做参数校验，execute 内自行校验并抛可读错误；
 * 这里集中声明各工具的 wire schema，供 schema JSON 克隆规范化后呈现给模型。
 * 命名遵循 snake_case 参数惯例（omo team-mode / Claude Code Agent Teams 对照）。
 */

export const str = (description: string) => ({ type: "string", description });

export const optStr = (description: string) => ({
  type: "string",
  description: `${description} (optional)`,
});

export const num = (description: string) => ({ type: "number", description });

/** 布尔参数。 */
export const bool = (description: string) => ({ type: "boolean", description });

export const arrayOfStr = (description: string) => ({
  type: "array",
  items: { type: "string" },
  description,
});

export const schemas = {
  // team_init 已下线（#51）：实例化移至 HTTP 面 /api/xiaozhuge/team/create。
  spawn: {
    parameters: {
      type: "object",
      properties: {
        member: str("Logical member name (role id), e.g. 'coder'."),
        durable_id: str("Durable subagent id returned by the subagent tool."),
        role: str("Role id defined in the team template."),
        tier: { type: "number", description: "Hierarchy tier (0 = Tier-0 master)." },
        parent: optStr("Direct parent member name; omit for root members."),
      },
      required: ["member", "durable_id", "role", "tier"],
      additionalProperties: false,
    },
  },
  // team_dispatch（ADR 0015，#67）：注册 → 指派 → 派单的复合原语，
  // 半事务语义——任一步失败即停，错误消息携带已完成步骤。
  dispatch: {
    parameters: {
      type: "object",
      properties: {
        member: str("Logical member name (role id), e.g. 'coder'."),
        durable_id: str("Durable subagent id returned by the subagent tool."),
        role: str("Role id; with role_inline this is the inline role's own name."),
        tier: { type: "number", description: "Hierarchy tier (0 = Tier-0 master)." },
        task_id: str("Task id returned by team_task_create; ledger-first, created before dispatch."),
        parent: optStr("Direct parent member name; omit for root members."),
        from: optStr("Sender member name for the assignment envelope (default 'root')."),
        provider: optStr("Per-role LLM provider override; omit to inherit the session default."),
        model: optStr("Per-role model override; omit to inherit the session default."),
        role_inline: {
          type: "object",
          description:
            "Inline role definition carried on the assignment envelope, not persisted (" +
            "prompt / briefing strings, dod string array, max_hops number, as_judge boolean).",
          properties: {
            prompt: { type: "string" },
            briefing: { type: "string" },
            dod: { type: "array", items: { type: "string" } },
            max_hops: { type: "number" },
            as_judge: { type: "boolean" },
          },
          additionalProperties: false,
        },
        expect_rev: num("Optimistic concurrency: expected ledger rev before assignment."),
      },
      required: ["member", "durable_id", "role", "tier", "task_id"],
      additionalProperties: false,
    },
  },
  inbox: {
    parameters: {
      type: "object",
      properties: {
        member: str("Your member name."),
        envelope_id: optStr("Claim this specific envelope instead of listing unread."),
      },
      required: ["member"],
      additionalProperties: false,
    },
  },
  ack: {
    parameters: {
      type: "object",
      properties: {
        member: str("Your member name."),
        envelope_id: str("Envelope id being acknowledged."),
      },
      required: ["member", "envelope_id"],
      additionalProperties: false,
    },
  },
  send: {
    parameters: {
      type: "object",
      properties: {
        to: str("Recipient member name."),
        from: str("Sender member name (your own member name)."),
        type: str("Message type, e.g. 'task-done', 'blocked', 'info'."),
        body: { description: "Message payload (any JSON value)." },
      },
      required: ["to", "from", "type", "body"],
      additionalProperties: false,
    },
    // 返回值固定 schema（#138，report-only）：warnings 恒在场——可达且树
    // 健康时为空数组，不可达/树违规时携带原因（不阻断投递）。
    description: "Deliver a message into another member's mailbox. Returns { ok, envelope_id, warnings }; warnings (always present) flags unreachable peers / tree violations (report-only).",
  },
  taskCreate: {
    parameters: {
      type: "object",
      properties: {
        title: str("Short task title."),
        room: str("Room the task belongs to."),
        assignee: optStr("Role assigned to execute the task."),
        touched_paths: arrayOfStr("Paths this task will touch (mutex assertion input)."),
        mutex_groups: arrayOfStr("Mutex group labels; running tasks sharing a group conflict."),
        max_rounds: num("Max patrol rounds for this task."),
        dod: arrayOfStr("DoD checklist items (judge verifies each)."),
        baseline: optStr("Baseline pointer (e.g. git ref) for redo reconciliation."),
      },
      required: ["title", "room"],
      additionalProperties: false,
    },
  },
  taskUpdate: {
    parameters: {
      type: "object",
      properties: {
        task_id: str("Task id returned by team_task_create."),
        status: {
          type: "string",
          enum: ["queued", "running", "blocked", "done", "cancelled"],
          description: "New status; must be a legal transition.",
        },
        assignee: optStr("New assignee role."),
        rounds: num("Current completed round count (monotonic)."),
        artifact: optStr("Artifact pointer once produced."),
        expect_rev: num("Optimistic concurrency: expected current rev."),
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  taskList: {
    parameters: {
      type: "object",
      properties: {
        room: optStr("Filter by room."),
        status: {
          type: "string",
          enum: ["queued", "running", "blocked", "done", "cancelled"],
          description: "Filter by status (optional).",
        },
      },
      additionalProperties: false,
    },
  },
  // team_reconcile（ADR 0015，#66）：对账全量视图一次返回；scope=audit 为
  // 旁路 report-only 子命令（只输出文件元数据，不读内容）。
  reconcile: {
    parameters: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["overview", "audit"],
          description:
            "overview (default): snapshot summary, member/ledger cross-view, task snapshot, " +
            "event cursors, goal placeholder. audit: additionally diffs ledger touched_paths " +
            "against the recorded workspace tree (metadata only).",
        },
      },
      additionalProperties: false,
    },
  },
  stateGet: {
    parameters: {
      type: "object",
      properties: {
        room: str("Room name."),
        role: optStr("Single role shard; omit to list all shards in the room."),
      },
      required: ["room"],
      additionalProperties: false,
    },
  },
  stateSet: {
    parameters: {
      type: "object",
      properties: {
        room: str("Room name."),
        role: str("Your member name (own your shard)."),
        status: {
          type: "string",
          enum: ["running", "blocked", "done"],
          description: "Reserved stage triplet.",
        },
        ext: { description: "Display-only business payload." },
      },
      required: ["room", "role", "status"],
      additionalProperties: false,
    },
  },
  handoff: {
    parameters: {
      type: "object",
      properties: {
        task_id: str("Task being handed off."),
        to_role: str("Receiving role."),
        receipt: arrayOfStr(
          "Judge mode only: per-DoD-item conclusions like 'pass: ...' / 'fail: ...'.",
        ),
      },
      required: ["task_id", "to_role"],
      additionalProperties: false,
    },
  },
} as const;
