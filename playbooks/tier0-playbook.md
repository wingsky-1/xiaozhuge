# Tier-0 Master Orchestration Playbook

> Baseline operational protocol for Tier-0 Master Orchestrator: plain text + `team_*` tools + `TEAM_HOME` persistence, with zero additional framework overhead. Drive continuity via `goal` autonomous rounds; perform crash recovery via state-level reconstruction.
>
> Vocabulary: This document uses framework protocol terminology only. All domain-specific knowledge MUST be injected via scenario templates.

## 0. Resource Protection Triad (Enforced throughout patrol)

| # | Guardrail | Enforcement Point | Default Value | Action on Breach |
|---|---|---|---|---|
| R1 | Concurrency Pool | Active tasks with `status=running` MUST NOT exceed $\min(\text{resources.max\_active\_rooms}, 3)$. Inspect via `team_task_list(status=running)` before `team_task_create`. | Pool limit = 3 | Over-quota tasks MUST remain `queued`; do not dispatch in current round. |
| R2 | Circuit Breaker | If `blocked_streak >= 3` consecutive turns without progress (no task status transition, no mailbox ack, no incoming events), trip circuit breaker: call `update_goal(action=blocked, blocked_reason="...")` and report escalation summary to human operator. | Threshold $N = 3$ turns | Cease task dispatch; halt patrol loop until human intervention. |
| R3 | Token & Round Budget | Single task with monotonic `rounds > max_rounds` is rejected by ledger (transitions to `blocked`). Session-level `max_goal_rounds` MUST be explicitly configured during initial human interaction turn via `create_goal(objective, max_goal_rounds)` (recommended: 8–16 rounds). Audit consumed rounds each turn via `get_goal`. | Single task: 3 turns / Goal: 8–16 rounds | Over-budget tasks transition to `blocked` and are highlighted in escalation summary. |

## 1. Startup Reconciliation (Deterministic execution order; execute on every startup or takeover)

0. **Readiness Gate (First Action)**: The very first tool call in this section MUST be `team_reconcile`. Successful execution confirms tool availability. Failure to execute MUST halt the turn and report an error summary: NEVER infer tool existence from memory; NEVER degrade silently to solo operation.
1. **Goal Verification & Rearm**: Call `get_goal`. If `phase=active` but `activation=disarmed` (typical after restart or circuit trip), prompt human operator to resume or send wake-up directive. In the initial human turn, if goal is missing, explicitly call `create_goal(objective, max_goal_rounds)`. Autonomous rounds cannot pause/resume goals; execute subsequent steps manually for the current turn if disarmed.
2. **Objective Anchoring (Verbatim Artifact)**: Read `rooms/root/brief/user-request.md`. If missing, write the verbatim user objective into this file. (Cold start = verbatim user task from activation message; Takeover = trace back to original prompt in conversation history, prepending `[Reconstructed excerpt, not raw input]`; Cross-generation takeover without history MUST request raw input from human operator). Instance root: `<DSH_HOME>/xiaozhuge/sessions/<sessionId>` (default `~/.dsh`). This file is the single authoritative ground truth of user intent across all team members. Dispatch briefs MUST paste this text verbatim in their background section and attach the file path as an anchor.
3. **Agent Liveness Check**: Compare all registered members in `agents.json` against live agents from `list_agents`. Mark missing members as `dead`; return their unfinished tasks to `queued`. **Tier-0 Exemption**: The Tier-0 master (`tier=0`) is the host root session, not a subagent, and will NOT appear in `list_agents` (durableId is current session ID). NEVER mark self as `dead`.
4. **Delivering TTL Harvest**: Harvest timed-out in-flight `.delivering` mailbox files and return them to pending status.
5. **Running Sentinel Cleanup**: Invalidate and reset blackboard partitions containing `"status":"running"`.
6. **Ledger & Event Cursor Verification**: Call `team_task_list` to load all tasks. Record the tail sequence number (`lastSeq`) of each room's event log as the cursor for the current turn. Report corrupted files truthfully; NEVER perform silent repairs.

## 2. State-Level Recovery (Crash recovery & takeover)

- MUST NOT invoke `send_message` on previous generation subagents (lineage validation will reject).
- Prescribed path = **State-Level Recovery**:
  1. Inspect `TEAM_HOME` state (`agents.json` + ledger + mailboxes + blackboard) to reconstruct operational snapshot.
  2. Discard uncommitted in-flight work (Startup Reconciliation Step 5).
  3. Read `rooms/root/brief/user-request.md` to retrieve raw user intent.
  4. Re-spawn team roles with fresh durable subagent IDs, injecting context summaries (completed, in-progress, pending).
  5. Resume dispatch from current ledger state; NEVER re-execute tasks marked `done`.

## 3. Patrol Loop (Executed sequentially on each autonomous turn)

### Step ① Harvest Inbox & Subagent Completion
- Call `team_inbox(member=<self>)` to read all pending envelopes.
- For completion notices: verify task state in ledger, then call `team_ack`.
- Immediately acknowledge processed envelopes to prevent timeout redelivery.

### Step ② Inspect Gates & Concurrency Isolation
- Inspect `gates/*.json`. Any task blocked by a `pending` gate MUST transition to `team_task_update(status=blocked)`.
- **Concurrency Isolation**: A task blocked on Gate MUST NOT stall independent tasks. Continue dispatching available tasks while pool capacity permits.
- Mirror pending gates to `todo_write` for human visibility. NEVER forge gate approvals (approvals MUST be decided via Gate Console).
- When a gate is `approved`, unblock task (transition to `running` or `queued`). When `denied`, mark `cancelled` and inform human operator.

### Step ③ Blocked Streak Tracking
- If no task leaves `blocked` and no progress occurs during the turn, increment `blocked_streak += 1`; reset to 0 upon any progress (task status change, mailbox ack, incoming event).
- If `blocked_streak >= 3` (R2 breach): trip circuit breaker by calling `update_goal(action=blocked, blocked_reason="Circuit tripped: 3 consecutive turns without progress")`, report escalation summary, and await human intervention.
- If single task `rounds` exceeds limit (R3 breach): ledger will reject transition; update task to `blocked`.

### Step ④ Concurrency-Aware Dispatch
- Count active `running` tasks to evaluate available capacity under R1.
- Pick tasks from `queued` in order. Dispatch via `team_dispatch` (registers member, assigns task, sends dispatch envelope in one atomic step; **MUST explicitly specify `parent=<self>`**). Alternatively, execute equivalent 3-step path (`team_spawn` + `team_task_update(assignee)` + `team_send`) with `parent=<self>`.
- **Mark Running Immediately**: Call `team_task_update(status=running)`. The state machine has no transition from `queued` directly to `done`. R1 slot accounting and R2 progress signals require `running` state.
- Wake agent via `send_message` (direct children only).

### Step ④′ Waiting Discipline
- **Single-Turn Bounded Wait**: When waiting on subagents, wait within the current turn using bounded wait (`job_output(wait=true)` with timeout $\le 10$ minutes, or bounded sleep + `team_reconcile`). Avoid multi-turn polling loops that waste full context tokens.
- **Max-Tokens Disarm Protection**: Do not concatenate massive outputs within one turn to avoid tripping context limits and causing goal disarm.
- **Low-Cost Inspection Turn**: If wait reaches limit and turn ends, the next turn operates as a low-cost check: call `team_reconcile` once; if no changes, terminate turn immediately without emitting empty events or blackboard noise.

### Step ⑤ Completion & Shutdown
- When all ledger tasks are `done` or `cancelled` and inbox is empty: call `update_goal(action=complete)` with final summary (task list, artifact pointers, audit event scope).
- If tasks remain: conclude current turn and await next goal round wake-up.

## 4. Operational Invariants

1. **Tool-Mediated State**: All state transitions MUST be committed through `team_*` tools. No side-channel file writes.
2. **Events Are Not Progress**: Progress is strictly defined by R2 (task state transitions, inbox acks, event ingestion), NOT by emitting empty events or noise.
3. **Reconciliation First**: The first action upon session start or takeover is ALWAYS the Startup Reconciliation protocol, never premature dispatch.
