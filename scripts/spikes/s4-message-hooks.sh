#!/usr/bin/env bash
# =============================================================================
# S4 spike：宿主能力「消息钩子可行性」验证脚本（issue #4 / P1）
#
# 验证插件可观测/解析用户消息流，并以 user-role 消息为人意凭证执行放行动作：
#   - 双打点对照：agent/inbox/inserted（实时同步）vs session/event（落账 firehose）
#   - 人意判定：source.kind === 'user' 与系统注入（kind=plugin 等）可区分
#   - nonce 凭证 PoC：user 消息含 GATE-NONCE-OK-7F3A → 插件写 approved 标记
#
# 预注册判据（issue #4 S4）：
#   Go    = 以 user-role 消息为人意凭证，实现真·对话批准双通道。
#   No-Go = 对话通道降级为对账引导，落账走 Web nonce 通道（ADR 记录偏离）。
#
# 用法：bash scripts/spikes/s4-message-hooks.sh
# 约束：全程 DSH_HOME=$(mktemp -d) 隔离。
# 判定报告：docs/adr/0004-s4-message-hooks.md
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/scripts/spikes/s4-probe-plugin"
DSH_BIN="$(command -v dsh || echo "$HOME/.local/node/bin/dsh")"

DSH_HOME="$(mktemp -d /tmp/dsh-spike-s4.XXXXXX)"
export DSH_HOME
LOG_DIR="$DSH_HOME/logs"; mkdir -p "$LOG_DIR"
export S4_PROBE_FILE="$LOG_DIR/probe.jsonl"
export S4_NONCE_FILE="$LOG_DIR/nonce-approved"

echo "== [0] 环境快照"
echo "DSH_HOME=$DSH_HOME"
"$DSH_BIN" --version | tee "$LOG_DIR/version.txt"
cp "$HOME/.dsh/settings.yaml" "$HOME/.dsh/.credentials.yaml" "$DSH_HOME/"

echo "== [1] 安装探针插件"
timeout 120 "$DSH_BIN" plugin --profile headless add "link:$PLUGIN_DIR" 2>&1 | tail -1

echo "== [2] 第一条用户消息：双打点观测"
timeout 180 "$DSH_BIN" --profile headless "Just reply with the word: ready" 2>&1 | tail -1

python3 - "$S4_PROBE_FILE" <<'PY'
import json, sys
recs = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
human_inbox = [r for r in recs if r["hook"] == "agent/inbox/inserted"
               and (r.get("source") or {}).get("kind") == "user"]
human_event = [r for r in recs if r["hook"] == "session/event"
               and (r.get("source") or {}).get("kind") == "user"]
assert human_inbox, "FAIL: inbox/inserted 未捕获 kind=user 消息"
assert human_event, "FAIL: session/event 未捕获 kind=user 消息"
same = human_inbox[0]["textHead"] == human_event[0]["textHead"] and human_inbox[0]["textLen"] > 0
order = human_inbox[0]["t"] <= human_event[0]["t"]
kinds = sorted({(r.get("source") or {}).get("kind") for r in recs})
print(f"dual-hook OK (same-text={same}, inbox-first={order})")
print(f"observed source.kind values: {kinds}")
sys.exit(0 if (same and order) else 1)
PY

echo "== [3] nonce 凭证 PoC：含 nonce 的 user 消息触发放行动作"
timeout 180 "$DSH_BIN" --profile headless "Approval code: GATE-NONCE-OK-7F3A. Just reply: ack" 2>&1 | tail -1
[ -f "$S4_NONCE_FILE" ] || { echo "FAIL: nonce 放行动作未触发"; exit 1; }
grep -q '"action":"gate-approved-by-nonce"' "$S4_PROBE_FILE"
echo "nonce action fired at $(cat "$S4_NONCE_FILE")"

echo "== [4] 判定：Go —— 插件可观测/解析用户消息流（role/source/全文可得），"
echo "且能以 user-role 消息为人意凭证执行放行动作（真·对话批准双通道最小形态成立）。"
echo "日志目录：$LOG_DIR"
