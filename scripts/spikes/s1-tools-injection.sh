#!/usr/bin/env bash
# =============================================================================
# S1 spike：宿主能力「tools 注入」验证脚本（issue #4 / P1）
#
# 验证最小插件经 cordis `tools` 注册的 `team_echo` 工具在两种会话形态下
# 均以原生工具呈现且可被模型成功调用：
#   (a) 根会话；(b) spawned subagent 会话。
#
# 预注册判据（issue #4 S1）：
#   Go   = 两形态中工具均以原生工具呈现、模型可成功调用且返回值正确。
#   No-Go = subagent 会话不继承全局注册 → 复评 MCP server 形态或
#           「skill 规程 + CLI」过渡态（ADR 裁决）。
#
# 用法：bash scripts/spikes/s1-tools-injection.sh
# 约束：全程 DSH_HOME=$(mktemp -d) 隔离；不触碰任何既有 dsh 进程。
# 判定报告：docs/spikes/s1-report.md
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/scripts/spikes/s1-team-echo-plugin"
MARKER="XIAOZHUGE_SPIKE_OK"
DSH_BIN="$(command -v dsh || echo "$HOME/.local/node/bin/dsh")"

DSH_HOME="$(mktemp -d /tmp/dsh-spike-s1.XXXXXX)"
export DSH_HOME
LOG_DIR="$DSH_HOME/logs"
mkdir -p "$LOG_DIR"

echo "== [0] 环境快照"
echo "DSH_HOME=$DSH_HOME"
"$DSH_BIN" --version | tee "$LOG_DIR/version.txt"
node --version >>"$LOG_DIR/version.txt"
uname -srm >>"$LOG_DIR/version.txt"
# 复用真实环境的 LLM provider 配置与凭证（settings.yaml 无敏感值，
# 凭证单独在 .credentials.yaml；两者一并复制到隔离 HOME）。
cp "$HOME/.dsh/settings.yaml" "$HOME/.dsh/.credentials.yaml" "$DSH_HOME/"

echo "== [1] 安装 spike 插件到全新 headless profile"
"$DSH_BIN" plugin --profile headless add "link:$PLUGIN_DIR" 2>&1 | tail -2 | tee "$LOG_DIR/plugin-add.txt"

echo "== [2] 记录 composition 与 tools.mode 取值"
"$DSH_BIN" --profile headless --dump-config >"$LOG_DIR/composition.txt" 2>&1
grep -n "spike-team-echo" "$LOG_DIR/composition.txt" || { echo "FAIL: composition 中无 spike-team-echo"; exit 1; }
grep -A3 "^- id: tools" "$LOG_DIR/composition.txt" | tee "$LOG_DIR/tools-mode.txt"
# 未设置 DSH_TOOLS_MODE 时 mode 为空（= schema 默认 native），此处断言环境干净。
[ -z "${DSH_TOOLS_MODE:-}" ] && echo "DSH_TOOLS_MODE unset -> presentation mode = native (default)" | tee -a "$LOG_DIR/tools-mode.txt"

SESSIONS_ROOT="$DSH_HOME/sessions"

check_latest_session() {
  # $1 = 期望 message 参数值；校验任一会话日志里存在对 team_echo 的成功调用。
  # 形态 B 中 subagent 会话先于父会话结束，不能只看「最新」一个日志，
  # 遍历全部会话取命中。兼容两种落盘形态：独立 tool/call|tool/result
  # 事件，或折叠进 assistant/message content 的 tool-call 块（headless
  # 快路径实证），故做内容级匹配而非依赖具体事件类型。
  local expect="$1"
  local f hit=""
  for f in "$SESSIONS_ROOT"/*/*/session.jsonl.zstd; do
    zstdcat "$f" >"$LOG_DIR/check-session.jsonl" 2>/dev/null || continue
    if python3 - "$expect" "$LOG_DIR/check-session.jsonl" <<'PY'
import json, sys
expect = sys.argv[1]
text = open(sys.argv[2], encoding="utf-8").read()
compact = text.replace(": ", ":").replace(", ", ",")
ok_call = '"name":"team_echo"' in compact and (
    f'\\"message\\":\\"{expect}\\"' in text or f'"message": "{expect}"' in text
)
ok_marker = "XIAOZHUGE_SPIKE_OK" in text
sys.exit(0 if (ok_call and ok_marker) else 1)
PY
    then hit="$f"; break; fi
  done
  if [ -n "$hit" ]; then
    echo "session-log check: OK ($hit)"
  else
    echo "session-log check: no session contains a successful team_echo(message=$expect)"
    return 1
  fi
}

echo "== [3] 形态 A：根会话调用"
"$DSH_BIN" --profile headless \
  "Call the team_echo tool exactly once with message set to 'root-form'. Then reply with the exact marker string from the tool result and nothing else." \
  2>&1 | tee "$LOG_DIR/form-a.out" | tail -3
grep -q "$MARKER" "$LOG_DIR/form-a.out" || { echo "FAIL: 形态A 最终回复无标记"; exit 1; }
check_latest_session root-form || { echo "FAIL: 形态A 会话日志校验未通过"; exit 1; }

echo "== [4] 形态 B：spawned subagent 会话调用"
"$DSH_BIN" --profile headless \
  "Use the subagent tool to run one subagent whose task is exactly: 'Call the team_echo tool once with message set to \"subagent-form\", then report the marker string from its tool result verbatim.' Wait for it to finish and reply with the reported marker string only." \
  2>&1 | tee "$LOG_DIR/form-b.out" | tail -3
grep -q "$MARKER" "$LOG_DIR/form-b.out" || { echo "FAIL: 形态B 最终回复无标记"; exit 1; }
check_latest_session subagent-form || { echo "FAIL: 形态B 会话日志校验未通过"; exit 1; }

echo "== [5] 判定：Go —— 两形态均原生呈现、模型成功调用、返回值正确"
echo "日志目录：$LOG_DIR （随临时 HOME 保留，供判定报告引用）"
