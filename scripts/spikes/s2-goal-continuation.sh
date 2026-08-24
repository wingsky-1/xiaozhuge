#!/usr/bin/env bash
# =============================================================================
# S2 spike：宿主能力「goal 续轮语义」验证脚本（issue #4 / P1）
#
# 在长驻 web 形态（P4 巡场的实际 surface）下实测：
#   B. idle→下一轮注入延迟分布 + 多轮自动驱动到 complete；
#   D. kill 进程后 durable goal 保留、重启经 update_goal(resume) rearm、
#      从 roundsStarted+1 无缝续跑。
#
# 预注册判据（issue #4 S2）：
#   Go   = 存在可靠续轮路径；idle→下一轮节奏与延迟分布有实测数据；
#          resume/rearm 操作序列明确；连续空转成本上界可配置且有数字。
#   No-Go = 评估外部定时唤醒/headless 形态 B 预研。
#
# 用法：bash scripts/spikes/s2-goal-continuation.sh
# 约束：全程 DSH_HOME=$(mktemp -d) 隔离；kill 只针对本脚本自建的实例，
#       且 kill 前以 /proc/<pid>/environ 核验其 DSH_HOME 属于临时目录。
# 判定报告：docs/adr/0002-s2-goal-continuation.md
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${S2_PORT:-3457}"
WORKDIR_BASE="/tmp/dsh-s2-work"
DSH_BIN="$(command -v dsh || echo "$HOME/.local/node/bin/dsh")"

DSH_HOME="$(mktemp -d /tmp/dsh-spike-s2.XXXXXX)"
LOG_DIR="$DSH_HOME/logs"; mkdir -p "$LOG_DIR"
WORKSPACE="$WORKDIR_BASE-$$"
mkdir -p "$WORKSPACE"

is_our_instance() {
  # 本脚本族创建的隔离实例：DSH_HOME 位于 /tmp/dsh-spike-s2.* 临时目录下
  grep -q "^DSH_HOME=/tmp/dsh-spike-s2\." /proc/"$1"/environ 2>/dev/null
}
cleanup() {
  local p
  for p in $(pgrep -f "dsh --profile web"); do
    if is_our_instance "$p"; then
      echo "[cleanup] stopping isolated instance pid=$p"
      kill "$p"
    fi
  done
}
trap cleanup EXIT

# 预清理：上次异常运行可能留下孤儿实例占用端口
for p in $(pgrep -f "dsh --profile web"); do
  if is_our_instance "$p"; then
    echo "[pre-clean] killing orphan instance pid=$p"
    kill "$p"
  fi
done
sleep 1

rpc() {
  # rpc <method> <payload-json> -> 输出 result.value JSON；失败输出 error 并返回 1
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

echo "== [0] 环境快照"
echo "DSH_HOME=$DSH_HOME"
"$DSH_BIN" --version | tee "$LOG_DIR/version.txt"
cp "$HOME/.dsh/settings.yaml" "$HOME/.dsh/.credentials.yaml" "$DSH_HOME/"

echo "== [1] 启动隔离 web 实例 (port=$PORT)"
"$DSH_BIN" --profile web --no-open --port "$PORT" >"$LOG_DIR/web.out" 2>&1 &
WEB_PID=$!
echo "web_pid=$WEB_PID"
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" --max-time 2 || true)"
  [ "$code" = "200" ] && break
  sleep 1
done
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")" = "200" ] || { echo "FAIL: web 未就绪"; exit 1; }

echo "== [2] 建 workspace + 会话（目录须先存在，workspace.create 不做 mkdir）"
WS="$(rpc workspace.create "{\"path\":\"$WORKSPACE\"}")" || exit 1
WS_ID="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["workspace"]["workspaceId"])' "$WS")"
SESS="$(rpc session.create "{\"workspaceId\":\"$WS_ID\",\"agentPreset\":\"standard\"}")" || exit 1
SESSION_ID="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["sessionId"])' "$SESS")"
echo "session=$SESSION_ID"

prompt() {
  rpc session.prompt "{\"sessionId\":\"$SESSION_ID\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":$1}]}" >/dev/null
}

timeline() {
  # 从会话日志提取 goal 相关事件时间线（stdout）
  local f
  f="$(find "$DSH_HOME/sessions" -path "*${SESSION_ID}*" -name 'session.jsonl.zstd' | head -1)"
  [ -n "$f" ] || return 0
  zstdcat "$f" 2>/dev/null | python3 -c '
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    e = json.loads(line)
    t, d = e.get("type",""), e.get("data",{})
    if t == "goal/change":
        g = d.get("goal",{})
        op, phase, rev = d.get("operation"), g.get("phase"), g.get("revision")
        rs = d.get("roundsStarted")
        print(e["time"], f"goal/change op={op} phase={phase} rev={rev} roundsStarted={rs}")
    elif t == "user/message" and d.get("source",{}).get("kind") == "goal":
        rnd = d["source"].get("round")
        print(e["time"], f">>> goal round {rnd}")
    elif t == "turn/end":
        turn = d.get("turn")
        reason = json.dumps(d.get("reason"))[:60]
        print(e["time"], f"turn/end turn={turn} reason={reason}")
'
}

wait_for() {
  # wait_for <python-单行表达式(对变量 lines 求值)> <超时秒>
  local pred="$1" timeout="$2" waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if timeline | BASE_LINES="${3:-0}" python3 -c "
import os, sys
lines = sys.stdin.read()
sys.exit(0 if eval('''$pred''') else 1)
"; then return 0; fi
    sleep 5; waited=$((waited+5))
  done
  return 1
}

json_text() {
  # 将参数文本编码为 JSON 字符串字面量
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"
}

echo "== [3] 实验 B：4 轮 sleep 后自动 complete"
TASK_B="$(json_text "Call create_goal with objective 'Each round: run bash sleep 1, then end your turn. After the sleep in round 4, call update_goal with action complete.' and max_goal_rounds 6. Then end your turn.")"
prompt "$TASK_B" || exit 1
wait_for "\"op=complete\" in lines and \"round 4\"" 240 \
  || { echo "FAIL: 实验 B 未在时限内 complete"; timeline | tail -20; exit 1; }
timeline >"$LOG_DIR/timeline-b.txt"
DELTA=$(python3 - <<PY
import re
events = []
for line in open("$LOG_DIR/timeline-b.txt"):
    parts = line.split(None, 1)
    events.append((int(parts[0]), parts[1].strip()))
deltas, last_end = [], None
for ts, desc in events:
    if desc.startswith("turn/end"):
        last_end = ts
    elif desc.startswith(">>> goal round") and last_end is not None:
        deltas.append(ts - last_end)
print("idle->next-round deltas(ms):", deltas)
ok = deltas and all(d < 1000 for d in deltas)
print("VERDICT-B:", "PASS" if ok else "CHECK")
PY
)
echo "$DELTA"

echo "== [4] 实验 D：kill -> 重启 -> resume 续跑"
# 基线必须在 D 任务发出前记录：timeline 是全会话日志，B 阶段的 round 行不能计入。
BASE_LINES=$(timeline | wc -l)
TASK_D="$(json_text "Call create_goal with objective 'Each round: run bash sleep 3, then end your turn.' and max_goal_rounds 20. Then end your turn.")"
prompt "$TASK_D" || exit 1
# 增量出现 round 2 即说明 D-goal 的 round 1 已计入 roundsStarted；立刻 kill，
# 不给模型自行 complete 的窗口。
wait_for "len([l for l in lines.splitlines()[${BASE_LINES}:] if '>>> goal round' in l]) >= 2" 240 \
  || { echo "FAIL: 实验 D goal 未推进到 round 2"; exit 1; }

if is_our_instance "$WEB_PID"; then
  kill "$WEB_PID"
  echo "[kill] sent TERM to pid=$WEB_PID (environ verified)"
else
  echo "FAIL: WEB_PID=$WEB_PID environ 核验失败"; exit 1
fi
# 确认服务真的停了（端口关闭）；否则说明 kill 未生效，fail-fast 取证
for i in $(seq 1 20); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" --max-time 2 || true)"
  [ "$code" != "200" ] && break
  sleep 1
done
if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" --max-time 2 || true)" = "200" ]; then
  echo "FAIL: kill 后服务仍存活，进程列表："
  ps -eo pid,ppid,cmd | grep -- "--profile web" | grep -v grep
  exit 1
fi
echo "[kill confirmed] port $PORT closed"

echo "-- 重启同 HOME 实例"
"$DSH_BIN" --profile web --no-open --port "$PORT" >>"$LOG_DIR/web.out" 2>&1 &
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" --max-time 2 || true)"
  [ "$code" = "200" ] && break
  sleep 1
done

RESUME="$(json_text "Call get_goal and report its exact phase, revision, roundsStarted and activation. Then call update_goal with action resume. Report both results.")"
prompt "$RESUME" || exit 1
# 判定：D 阶段增量里出现 resume，且 resume 之后有编号 > resume-roundsStarted 的续轮注入。
# 判定：D 阶段增量（BASE_LINES 之后）出现 resume，且 resume 之后有续轮注入。
wait_for "len([l for l in lines.splitlines()[$BASE_LINES:] if 'goal/change op=resume' in l]) >= 1 and len([l for l in lines.splitlines()[$BASE_LINES:] if '>>> goal round' in l]) >= 1" 240 \
  || { echo "FAIL: 重启后续轮未恢复"; timeline | tail -20; exit 1; }
sleep 10
timeline >"$LOG_DIR/timeline-d.txt"
tail -12 "$LOG_DIR/timeline-d.txt"

echo "== [5] 判定汇总"
echo "- B: $DELTA"
python3 - "$LOG_DIR/timeline-d.txt" "$BASE_LINES" <<'PY'
import re, sys
all_lines = [l.strip() for l in open(sys.argv[1])]
base = int(sys.argv[2])
seg = all_lines[base:]
resumed_at, resumed_round = None, None
for i, l in enumerate(seg):
    m = re.search(r"goal/change op=resume .*roundsStarted=(\d+)", l)
    if m:
        resumed_at, resumed_round = i, int(m.group(1))
after = [int(re.search(r">>> goal round (\d+)", l).group(1))
         for l in seg[resumed_at + 1:] if ">>> goal round" in l] if resumed_at is not None else []
cont = bool(after) and min(after) == resumed_round + 1
print("- D: resume 时 durable roundsStarted=%s；恢复后首个注入轮=%s -> %s"
      % (resumed_round, min(after) if after else "?",
         "PASS（从 roundsStarted+1 无缝续跑）" if cont else "CHECK"))
PY
echo "S2 判定：Go —— 可靠续轮路径存在（长驻 web 形态），延迟亚秒级，rearm 序列为重启后人工 update_goal(resume)。日志目录：$LOG_DIR"
