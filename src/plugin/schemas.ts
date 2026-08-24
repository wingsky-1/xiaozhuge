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
  init: {
    parameters: {
      type: "object",
      properties: {
        instance_note: optStr("Optional human-readable note for this team instance."),
      },
      additionalProperties: false,
    },
  },
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
