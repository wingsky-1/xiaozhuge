#!/usr/bin/env bash
# =============================================================================
# S3 spike：宿主能力「跨代 subagent 接管」验证脚本（issue #4 / P1）
#
# 场景：种子会话 spawn 一个 durable background subagent 后退出（或被 kill），
# 全新的根会话尝试对该 subagent 调 send_message 接管。
#
# 预注册判据（issue #4 S3）：
#   Go    = 可接管。
#   No-Go = （预期概率高）放弃进程级接管，降级「状态级重建」——新根重新 spawn
#           全套角色，凭 TEAM_HOME 启动对账恢复现场（产出已在黑板/账本，丢的只是
#           进程内上下文）；P4 验收随之改为「续跑完成同一任务且无重复劳动」。
#
# 用法：bash scripts/spikes/s3-takeover.sh
# 约束：全程 DSH_HOME=$(mktemp -d) 隔离；本脚本不 kill 任何进程（种子 runner
#       投递完任务后自然退出，即产生孤儿 durable subagent——与 kill 死法在
#       lineage 校验上等价：校验只比对持久化 parentSession 与调用者 session id）。
# 判定报告：docs/adr/0006-s3-subagent-takeover.md
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DSH_BIN="$(command -v dsh || echo "$HOME/.local/node/bin/dsh")"

DSH_HOME="$(mktemp -d /tmp/dsh-spike-s3.XXXXXX)"
export DSH_HOME
LOG_DIR="$DSH_HOME/logs"; mkdir -p "$LOG_DIR"

echo "== [0] 环境快照"
echo "DSH_HOME=$DSH_HOME"
"$DSH_BIN" --version | tee "$LOG_DIR/version.txt"
cp "$HOME/.dsh/settings.yaml" "$HOME/.dsh/.credentials.yaml" "$DSH_HOME/"

echo "== [1] 种子会话：spawn durable background subagent"
timeout 300 "$DSH_BIN" --profile headless \
  "Use the subagent tool to start exactly one background (run_in_background) subagent. Its task: 'Repeat forever: sleep 10 then say still alive.' After starting it, report ONLY the subagent id string verbatim and end your turn." \
  >"$LOG_DIR/seed.out" 2>&1
CHILD_ID="$(grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' "$LOG_DIR/seed.out" | tail -1)"
[ -n "$CHILD_ID" ] || { echo "FAIL: 未取得 subagent id"; cat "$LOG_DIR/seed.out"; exit 1; }
echo "child_id=$CHILD_ID"

echo "== [2] 核对子会话血缘头（parentSession / origin / delegationDepth）"
CHILD_LOG="$(find "$DSH_HOME/sessions" -path "*${CHILD_ID}*" -name 'session.jsonl.zstd' | head -1)"
# 先解压首行再校验：避免 pipefail 下 head -1 触发 zstdcat SIGPIPE 污染退出码
HEADER="$(zstdcat "$CHILD_LOG" | head -1)" || true
printf '%s\n' "$HEADER" > "$LOG_DIR/child-header.json"
printf '%s\n' "$HEADER" | python3 -c '
import json, sys
h = json.loads(sys.stdin.read())
assert h.get("origin") == "subagent", h
assert h.get("parentSession"), h
assert h.get("delegationDepth") == 1, h
print("lineage header OK:", {k: h[k] for k in ("id", "parentSession", "origin", "delegationDepth")})
' || { echo "FAIL: 血缘头不符"; exit 1; }

echo "== [3] 新根会话尝试接管（send_message + list_agents）"
timeout 300 "$DSH_BIN" --profile headless \
  "Call send_message with subagent_id '$CHILD_ID' and message 'still alive?'. Report the EXACT tool result text (success or error) verbatim. Also call list_agents and report its exact output." \
  >"$LOG_DIR/takeover.out" 2>&1
tail -6 "$LOG_DIR/takeover.out"

NEW_SESSION_LOG="$(find "$DSH_HOME/sessions" -name 'session.jsonl.zstd' | sort | tail -1)"
zstdcat "$NEW_SESSION_LOG" | python3 -c '
import json, sys
err, empty_list = None, False
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    e = json.loads(line)
    if e.get("type") != "tool/result":
        continue
    blocks = e["data"]["message"]["content"]
    is_err = bool(e["data"]["message"]["content"][0].get("isError"))
    text = json.dumps(blocks, ensure_ascii=False)
    # send_message 失败结果：isError 且含 lineage 拒绝文案
    if is_err and "belongs to another parent session" in text:
        err = text
    if "(no subagents)" in text or "\"items\":[]" in text.replace(" ", ""):
        empty_list = True
print("takeover-error:", (err[:400] if err else "NOT FOUND"))
print("list_agents-empty:", empty_list)
sys.exit(0 if (err) else 1)
' || {
  echo "== 判定：未复现预期的 lineage 拒绝 —— 请人工核查 $LOG_DIR"
  exit 1
}

echo "== [4] 状态级重建数据面抽查：新根可直接读取子会话日志（TEAM_HOME 对账路径）"
zstdcat "$CHILD_LOG" | grep -c '"type"' | xargs echo "child log events readable:"

echo "== [5] 判定：No-Go —— 新根接管被 lineage 校验拒绝"
echo "错误形态：UNAUTHORIZED / belongs to another parent session；list_agents 对旧 child 不可见。"
echo "触发预注册回退：放弃进程级接管，降级「状态级重建」（P4 验收改为续跑同一任务且无重复劳动）。"
echo "日志目录：$LOG_DIR"
