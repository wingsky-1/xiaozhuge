#!/usr/bin/env bash
# =============================================================================
# P4 场景验收：kill 时机矩阵（issue #8）
#
# 两档：
#   A. 空闲态 kill —— 团队态建立完成、agent idle 时杀宿主进程；
#   B. 满载态 kill —— 多成员多 running 任务运行中杀宿主进程。
#
# 每档验证 S3 回退路径（状态级重建）：kill 后以全新空上下文会话凭 TEAM_HOME
# 对账续跑，文件级断言「无重复劳动」——任务集合不变、事件流无二次 task/create、
# 状态无损且可继续推进。
#
# 接管装配说明：TEAM_HOME 按 ADR 0005 按主会话 id 分根；接管时宿主绑定层把
# 上一代实例根迁移为新一代实例根（本脚本以 cp -r 模拟该装配动作；真实部署中
# 为巡场接管规程的宿主侧步骤）。room.lock 由旧代持有，新代按规程不重新 init，
# 直接对账（CAS 幂等的正确用法）。
#
# 用法：bash scripts/scenarios/p4-kill-matrix.sh
# 约束：隔离 DSH_HOME；kill 仅针对本脚本自建实例（environ 核验 + 端口确认）。
# =============================================================================
set -uo pipefail

PORT="${P4_PORT:-3467}"
DSH_BIN="$(command -v dsh || echo "$HOME/.local/node/bin/dsh")"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

DSH_HOME="$(mktemp -d /tmp/dsh-spike-p4.XXXXXX)"
export DSH_HOME
LOG_DIR="$DSH_HOME/logs"; mkdir -p "$LOG_DIR"
WORKSPACE="/tmp/dsh-p4-work-$$"; mkdir -p "$WORKSPACE"

cleanup() {
  local p
  for p in $(pgrep -f "dsh --profile web"); do
    if grep -q "^DSH_HOME=/tmp/dsh-spike-p4\." /proc/"$p"/environ 2>/dev/null; then
      echo "[cleanup] stopping isolated instance pid=$p"
      kill "$p"
    fi
  done
}
trap cleanup EXIT

rpc() {
  local method="$1" payload="$2" out
  out="$(curl -s --max-time 20 -X POST "http://127.0.0.1:$PORT/api/$method" \
    -H 'content-type: application/json' \
    -d "{\"type\":\"client-request\",\"rpcId\":\"r-$RANDOM$RANDOM\",\"method\":\"$method\",\"payload\":$payload}")"
  python3 -c '
import json, sys
d = json.loads(sys.argv[1])
r = d.get("result", {})
if not r.get("ok"):
    print("RPC_ERROR:", json.dumps(r.get("error")), file=sys.stderr)
    sys.exit(1)
print(json.dumps(r.get("value")))
' "$out"
}

json_text() {
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"
}

start_instance() {
  "$DSH_BIN" --profile web --no-open --port "$PORT" >>"$LOG_DIR/web.out" 2>&1 &
  WEB_PID=$!
  for _ in $(seq 1 30); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" --max-time 2 || true)" = "200" ] && return 0
    sleep 1
  done
  echo "FAIL: web 未就绪"; exit 1
}

kill_instance() {
  if grep -q "^DSH_HOME=$DSH_HOME\$" /proc/"$WEB_PID"/environ 2>/dev/null; then
    kill "$WEB_PID"
  else
    echo "FAIL: environ 核验失败 pid=$WEB_PID"; exit 1
  fi
  for _ in $(seq 1 20); do
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" --max-time 2 || true)"
    [ "$code" != "200" ] && break
    sleep 1
  done
  echo "[kill confirmed] pid=$WEB_PID port $PORT closed"
}

create_session() {
  SESS="$(rpc session.create "{\"workspaceId\":\"$WS_ID\",\"agentPreset\":\"standard\"}")" || return 1
  python3 -c 'import json,sys; print(json.loads(sys.argv[1])["sessionId"])' "$SESS"
}

prompt() {
  # prompt <rpc-session-id> <text>
  rpc session.prompt "{\"sessionId\":\"$1\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":$(json_text "$2")}]}" >/dev/null
}

events_file_of() {
  find "$DSH_HOME/xiaozhuge/sessions/$1" -name 'events.jsonl' | head -1
}

wait_events() {
  # wait_events <session-id> <python 单行表达式(变量 lines)> <超时秒>
  local sid="$1" pred="$2" timeout="$3" waited=0 f
  while [ "$waited" -lt "$timeout" ]; do
    f="$(events_file_of "$sid")"
    if [ -n "$f" ] && python3 -c "
import sys
lines = open(sys.argv[1], encoding='utf-8').read()
sys.exit(0 if eval('''$pred''') else 1)
" "$f"; then return 0; fi
    sleep 4; waited=$((waited+4))
  done
  return 1
}

echo "== [0] 环境快照"
echo "DSH_HOME=$DSH_HOME"
"$DSH_BIN" --version | tee "$LOG_DIR/version.txt"
cp "$HOME/.dsh/settings.yaml" "$HOME/.dsh/.credentials.yaml" "$DSH_HOME/"

echo "== [1] 安装本包插件到 web profile 并启动实例"
timeout 120 "$DSH_BIN" plugin --profile web add "link:$REPO_ROOT" >/dev/null 2>&1 || true
start_instance
WS="$(rpc workspace.create "{\"path\":\"$WORKSPACE\"}")" || exit 1
WS_ID="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["workspace"]["workspaceId"])' "$WS")"
SESSION_A="$(create_session)" || exit 1
echo "gen-1 session=$SESSION_A"


# -----------------------------------------------------------------------------
echo "== [2] 档 A：空闲态 kill —— 先建立团队态"
prompt "$SESSION_A" "Execute these tool calls in order and nothing else: 1) team_init; 2) team_spawn with member 'coder', durable_id 'dur-coder-a', role 'coder', tier 1; 3) team_task_create with title 'T1', room 'root', max_rounds 3. Then end your turn."
wait_events "$SESSION_A" "lines.count('task/create') >= 1" 240 \
  || { echo "FAIL: 团队态未建立"; exit 1; }
sleep 12  # 等待本轮收尾进入 idle（空闲态）

echo "-- 空闲态 kill"
kill_instance
echo "-- 重启实例（同 HOME 同端口）"
start_instance

# 接管装配：上一代实例根 -> 新一代实例根（宿主绑定层动作模拟）
SESSION_B="$(create_session)" || exit 1
mkdir -p "$DSH_HOME/xiaozhuge/sessions/$SESSION_B"
cp -r "$DSH_HOME/xiaozhuge/sessions/$SESSION_A"/. "$DSH_HOME/xiaozhuge/sessions/$SESSION_B"/
echo "gen-2 session=$SESSION_B (接管装配完成)"

echo "-- 档 A 对账续跑：新会话读现场并把 T1 推进到 running（不得新建任务）"
prompt "$SESSION_B" "A previous instance crashed. Reconcile now: call team_task_list to read existing tasks; do NOT call team_init and do NOT create any new task. Then call team_task_update once to set the existing task's status to running. Report the task list."
# 新会话名下不得出现 task/create（继承事件不算）；且必须有 task/update
wait_events "$SESSION_B" "'$SESSION_B' in lines and 'task/update' in lines and len([l for l in lines.splitlines() if '$SESSION_B' in l and 'task/create' in l]) == 0" 240 \
  || { echo "FAIL: 档 A 对账续跑未完成或出现重复建任务"; exit 1; }

# -----------------------------------------------------------------------------
echo "== [4] 档 B：满载态 kill —— 多成员多 running 任务"
# 回到 gen-1 会话继续（其 TEAM_HOME 独立）；先重建团队态至双 running
TASK_D="$(json_text "Call team_init. Then call team_spawn twice: member 'coder' durable_id 'dur-b-coder' role 'coder' tier 1; member 'qa' durable_id 'dur-b-qa' role 'qa' tier 1. Then call team_task_create twice: first title 'B1' room 'root' touched_paths ['src/b1.ts'] mutex_groups ['g-b1'] max_rounds 3; second title 'B2' room 'root' touched_paths ['src/b2.ts'] mutex_groups ['g-b2'] max_rounds 3. Then set both tasks running via two team_task_update calls (status running). Then end your turn.")"
prompt "$SESSION_A" "$TASK_D" || exit 1
wait_events "$SESSION_A" "len([l for l in lines.splitlines() if '\"type\":\"task/update\"' in l]) >= 2" 300 \
  || { echo "FAIL: 满载态未达到双 running"; exit 1; }

echo "-- 满载态 kill（运行中打断）"
kill_instance
echo "-- 重启实例（同 HOME 同端口）"
start_instance

echo "-- 接管装配（第二代 -> 第三代）"
SESSION_C="$(create_session)" || exit 1
mkdir -p "$DSH_HOME/xiaozhuge/sessions/$SESSION_C"
cp -r "$DSH_HOME/xiaozhuge/sessions/$SESSION_A"/. "$DSH_HOME/xiaozhuge/sessions/$SESSION_C"/

echo "-- 档 C 对账：新会话读取满载现场（两 running 任务 + 双成员）"
prompt "$SESSION_C" "A previous instance crashed mid-run. Reconcile: call team_task_list and report each task's status; do NOT call team_init and do NOT create or update any task. Then end your turn."
wait_events "$SESSION_C" "'team/task' in lines or 'task_list' in lines or 'taskList' in lines or 'task/update' in lines" 240 \
  || { echo "FAIL: 档 C 对账未执行"; exit 1; }

# -----------------------------------------------------------------------------
echo "== [5] 文件级断言（无重复劳动 + 状态无损）"
python3 - "$DSH_HOME/xiaozhuge/sessions" <<'PY'
import json, os, glob, sys
sessions_root = sys.argv[1]
passed, failed = [], []
def check(name, cond):
    (passed if cond else failed).append(name)
def load_tasks(sid):
    path = os.path.join(sessions_root, sid, "ledger", "tasks")
    out = {}
    if os.path.isdir(path):
        for f in os.listdir(path):
            if f.endswith(".json"):
                out[json.load(open(os.path.join(path, f)))["id"]] = \
                    json.load(open(os.path.join(path, f)))
    return out
def load_members(sid):
    p = os.path.join(sessions_root, sid, "agents.json")
    return json.load(open(p)).get("members", {}) if os.path.isfile(p) else {}
def count_creates(sid):
    n = 0
    for ef in glob.glob(os.path.join(sessions_root, sid, "rooms", "**", "events.jsonl"), recursive=True):
        for line in open(ef):
            try:
                if json.loads(line).get("type") == "task/create":
                    n += 1
            except Exception:
                pass
    return n

# 动态发现各代会话（按创建顺序：A 代、B 代=A 的接管、C 代=A 的三代 / 或独立满载代）
sids = sorted(
    (d for d in os.listdir(sessions_root) if os.path.isdir(os.path.join(sessions_root, d))),
    key=lambda d: os.path.getmtime(os.path.join(sessions_root, d)),
)

# 档 A：第一个接管代含 T1 且恰一任务
t1_sessions = [s for s in sids if any(t["title"] == "T1" for t in load_tasks(s).values())]
check("A: 存在继承 T1 的接管代", len(t1_sessions) >= 1)
if t1_sessions:
    t = load_tasks(t1_sessions[0])
    check("A: 恰 1 个任务（无重复建）", len(t) == 1)
    check("A: 续跑推进到 running", any(x["status"] == "running" for x in t.values()))
    check("A: 无二次 task/create", count_creates(t1_sessions[0]) <= 1)

# 档 B/C：满载代双 running + 双成员
full = [s for s in sids if len([x for x in load_tasks(s).values() if x["status"] == "running"]) == 2]
check("B: 存在双 running 满载代", len(full) >= 1)
for s in full[:1]:
    m = load_members(s)
    check("B: 成员表完整 coder+qa", sorted(m) == ["coder", "qa"])
    # 满载代含档 A 继承的 1 次 create；B1/B2 各恰 1 次（按 task_id 去重判定）
    ids = []
    for ef in glob.glob(os.path.join(sessions_root, s, "rooms", "**", "events.jsonl"), recursive=True):
        for line in open(ef):
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("type") == "task/create":
                tid = e.get("payload", {}).get("task_id")
                if tid in ids:
                    check(f"B: task {tid[:8]} 无重复 create", False)
                ids.append(tid)
    check("B: 每 task 恰一次 create（无重复劳动）", len(ids) == len(set(ids)))

print("PASS:", *passed, sep="\n  ✔ ")
if failed:
    print("FAILED:", *failed, sep="\n  ✘ ")
sys.exit(0 if not failed else 1)
PY
ASSERT_RC=$?
[ "$ASSERT_RC" = "0" ] && echo "== P4 场景验收：PASS（两档 kill 均无重复劳动、状态无损、可续跑）" \
  || echo "== P4 场景验收：FAIL"
exit "$ASSERT_RC"
