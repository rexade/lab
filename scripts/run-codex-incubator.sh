#!/bin/bash
# run-codex-incubator.sh - generic Codex runner for the mounted Pi Pulse project
# Reads /home/admin/lab/projects/mounted.json unless a status.json path is passed.

set -euo pipefail

LAB_DIR=${LAB_DIR:-/home/admin/lab}
MOUNTED_CONFIG=${MOUNTED_CONFIG:-$LAB_DIR/projects/mounted.json}
TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
TODAY=$(date '+%Y-%m-%d')
CODEX_BIN=${CODEX_BIN:-/home/admin/.npm-global/bin/codex}

if [ ! -x "$CODEX_BIN" ]; then
  CODEX_BIN=$(command -v codex || true)
fi
if [ -z "$CODEX_BIN" ] || [ ! -x "$CODEX_BIN" ]; then
  echo "[codex-incubator] codex binary not found; set CODEX_BIN or add codex to PATH" >&2
  exit 127
fi

STATUS_PATH=${1:-}
if [ -z "$STATUS_PATH" ]; then
  STATUS_PATH=$(node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); if (!p.labStatus) process.exit(2); console.log(p.labStatus)" "$MOUNTED_CONFIG")
fi

read_json_field() {
  node -e "const fs=require('fs'); const o=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const v=o[process.argv[2]]; if (v == null) process.exit(2); console.log(Array.isArray(v) ? v.join(' ') : v)" "$STATUS_PATH" "$1"
}

PROJECT=$(read_json_field project)
PROJECT_DIR=$(read_json_field repo)
LOG_FILE=$(read_json_field runLog)
PROMPT_DIR=$(node -e "const fs=require('fs'); const o=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(o.promptDir || (o.repo + '/prompts'))" "$STATUS_PATH")
RECENT_FILE=$(node -e "const fs=require('fs'); const path=require('path'); const o=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(o.recentRuns || path.join(path.dirname(o.runLog), 'RECENT_RUNS.md'))" "$STATUS_PATH")
FEEDBACK_FILE=$(node -e "const fs=require('fs'); const path=require('path'); const o=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(o.feedbackPath || path.join(o.repo, 'reports', 'USER_FEEDBACK.md'))" "$STATUS_PATH")
CODEX_MODEL=$(node -e "const fs=require('fs'); const o=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(o.codexModel || process.env.CODEX_MODEL || '')" "$STATUS_PATH")
CODEX_BYPASS=$(node -e "const fs=require('fs'); const o=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(o.codexBypass || process.env.CODEX_BYPASS === '1' ? '1' : '')" "$STATUS_PATH")

GODOT_AI_ENABLED=$(node -e "const fs=require(\"fs\"); const o=JSON.parse(fs.readFileSync(process.argv[1], \"utf8\")); console.log(o.godotAi?.enabled ? \"1\" : \"\")" "$STATUS_PATH")
GODOT_AI_MCP_URL=$(node -e "const fs=require(\"fs\"); const o=JSON.parse(fs.readFileSync(process.argv[1], \"utf8\")); console.log(o.godotAi?.mcpUrl || \"\")" "$STATUS_PATH")
GODOT_AI_STATUS_URL=$(node -e "const fs=require(\"fs\"); const o=JSON.parse(fs.readFileSync(process.argv[1], \"utf8\")); console.log(o.godotAi?.statusUrl || \"http://127.0.0.1:8020/godot-ai/status\")" "$STATUS_PATH")
GODOT_AI_VERSION=$(node -e "const fs=require(\"fs\"); const o=JSON.parse(fs.readFileSync(process.argv[1], \"utf8\")); console.log(o.godotAi?.serverVersion || \"\")" "$STATUS_PATH")
GODOT_AI_LOG=$(node -e "const fs=require(\"fs\"); const o=JSON.parse(fs.readFileSync(process.argv[1], \"utf8\")); console.log(o.godotAi?.log || ((o.repo || \"/home/admin/lab\") + \"/reports/godot-ai/editor.log\"))" "$STATUS_PATH")

godot_ai_mcp_ready() {
  local status
  status=$(curl -s "$GODOT_AI_STATUS_URL" || true)
  if [ -n "$GODOT_AI_VERSION" ] && ! printf '%s' "$status" | grep -q "\"server_version\":\"$GODOT_AI_VERSION\""; then
    return 1
  fi
  if [ -z "$GODOT_AI_VERSION" ] && ! printf '%s' "$status" | grep -q "server_version"; then
    return 1
  fi

  curl -s -X POST "$GODOT_AI_MCP_URL" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"codex-incubator-smoke","version":"0"}}}' \
    | grep -q '"result"'
}

start_godot_ai_editor() {
  local godot_bin="/home/admin/godot/Godot_v4.6.1-stable_linux.arm64"
  local log_dir
  log_dir=$(dirname "$GODOT_AI_LOG")
  mkdir -p "$log_dir"
  setsid env \
    GODOT_AI_ALLOW_HEADLESS=1 \
    GODOT_AI_DISABLE_TELEMETRY=true \
    DISABLE_TELEMETRY=true \
    PATH="/home/admin/.local/bin:$PATH" \
    "$godot_bin" --headless --editor --path "$PROJECT_DIR" \
    > "$GODOT_AI_LOG" 2>&1 < /dev/null &
}

ensure_godot_ai_bridge() {
  if [ -z "$GODOT_AI_ENABLED" ]; then
    return 0
  fi

  local godot_bin="/home/admin/godot/Godot_v4.6.1-stable_linux.arm64"
  local uvx_bin="/home/admin/.local/bin/uvx"
  local editor_pattern="$godot_bin --headless --editor --path $PROJECT_DIR"

  if [ ! -x "$godot_bin" ] || [ ! -x "$uvx_bin" ]; then
    echo "[codex-incubator] godot-ai bridge skipped: missing godot or uvx" >&2
    return 0
  fi

  if ! pgrep -f "$editor_pattern" >/dev/null 2>/dev/null; then
    start_godot_ai_editor
  fi

  for _ in $(seq 1 15); do
    if godot_ai_mcp_ready; then
      return 0
    fi
    sleep 1
  done

  echo "[codex-incubator] godot-ai bridge stale; restarting editor/server" >&2
  pkill -TERM -f "$editor_pattern" >/dev/null 2>/dev/null || true
  if [ -f "/home/admin/.local/share/godot/app_userdata/Tidebound Harbor Godot/godot_ai_server.pid" ]; then
    kill -TERM "$(cat "/home/admin/.local/share/godot/app_userdata/Tidebound Harbor Godot/godot_ai_server.pid")" >/dev/null 2>/dev/null || true
  fi
  sleep 2
  start_godot_ai_editor

  for _ in $(seq 1 30); do
    if godot_ai_mcp_ready; then
      return 0
    fi
    sleep 1
  done

  echo "[codex-incubator] godot-ai bridge did not become MCP-ready at $GODOT_AI_MCP_URL" >&2
}


ensure_godot_ai_bridge

RUN_TYPES_RAW=$(node -e "const fs=require('fs'); const o=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log((o.runTypes || ['mutate','research','mutate']).join(' '))" "$STATUS_PATH")
read -r -a RUN_TYPES <<< "$RUN_TYPES_RAW"

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$RECENT_FILE")"
touch "$LOG_FILE"

LAST_RUN=$(grep -oE "^## Run [0-9]+" "$LOG_FILE" 2>/dev/null | grep -oE "[0-9]+" | sort -n | tail -1 || true)
STATUS_RUN_COUNT=$(node -e "const fs=require('fs'); try { const o=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(Number(o.runCount || 0)) } catch { console.log(0) }" "$STATUS_PATH")
RUN_COUNT=$(node -e "console.log(Math.max(Number(process.argv[1] || 0), Number(process.argv[2] || 0)))" "${LAST_RUN:-0}" "$STATUS_RUN_COUNT")
RUN_NUMBER=$((RUN_COUNT + 1))

REQUESTED_TYPE=${2:-}
if [[ "$REQUESTED_TYPE" =~ ^(create|mutate|research|harvest)$ ]] && [ -f "$PROMPT_DIR/$REQUESTED_TYPE.md" ]; then
  RUN_TYPE="$REQUESTED_TYPE"
else
  RUN_TYPE="${RUN_TYPES[$((RUN_COUNT % ${#RUN_TYPES[@]}))]}"
fi

PROMPT_FILE="$PROMPT_DIR/$RUN_TYPE.md"
if [ ! -f "$PROMPT_FILE" ]; then
  echo "[codex-incubator] missing prompt: $PROMPT_FILE" >&2
  exit 1
fi

echo "[codex-incubator] $TIMESTAMP - starting $PROJECT $RUN_TYPE run (#$RUN_NUMBER)"

python3 - "$LOG_FILE" "$RECENT_FILE" << 'PYEOF'
import sys, re

log_path, recent_path = sys.argv[1], sys.argv[2]
try:
    text = open(log_path).read()
except FileNotFoundError:
    text = ""

sections = re.split(r'(?=^## Run \d)', text, flags=re.MULTILINE)
runs = [s.strip() for s in sections if s.strip().startswith("## Run")]
recent = runs[-4:] if len(runs) >= 4 else runs

with open(recent_path, 'w') as f:
    f.write("# Recent Runs\n\n")
    f.write("*Auto-generated. Last 4 runs. Full history in RUN_LOG.md.*\n\n---\n\n")
    f.write("\n\n---\n\n".join(recent) if recent else "*(no runs yet)*\n")
PYEOF

cd "$PROJECT_DIR"
FEEDBACK_BLOCK=""
if [ -f "$FEEDBACK_FILE" ]; then
  FEEDBACK_TEXT=$(tail -n 80 "$FEEDBACK_FILE" || true)
  if [ -n "$FEEDBACK_TEXT" ]; then
    FEEDBACK_BLOCK=$(printf '\n\nUSER FEEDBACK / STEERING NOTES:\n%s' "$FEEDBACK_TEXT")
  fi
fi
FULL_PROMPT=$(printf 'Run number: %s\nRun date: %s\nRun type: %s\n\n%s%s' "$RUN_NUMBER" "$TODAY" "$RUN_TYPE" "$(cat "$PROMPT_FILE")" "$FEEDBACK_BLOCK")
CODEX_EXIT=0
CODEX_ARGS=(exec -C "$PROJECT_DIR" --add-dir "$LAB_DIR" --color never)
if [ -n "$CODEX_BYPASS" ]; then
  CODEX_ARGS+=("--dangerously-bypass-approvals-and-sandbox")
else
  CODEX_ARGS+=("--sandbox" "workspace-write")
fi
if [ -n "$CODEX_MODEL" ]; then
  CODEX_ARGS+=("--model" "$CODEX_MODEL")
fi

OUTPUT=$("$CODEX_BIN" "${CODEX_ARGS[@]}" "$FULL_PROMPT" 2>&1) || CODEX_EXIT=$?

if [ "$CODEX_EXIT" -ne 0 ]; then
  OUTPUT="[run failed - codex exited $CODEX_EXIT]

$OUTPUT"
fi

STDOUT_DIR="$(dirname "$LOG_FILE")/stdout"
STDOUT_FILE="$STDOUT_DIR/codex-run-$RUN_NUMBER.log"
mkdir -p "$STDOUT_DIR"
printf '%s\n' "$OUTPUT" > "$STDOUT_FILE"

if [ "$CODEX_EXIT" -ne 0 ]; then
  FAILURE_DETAIL=$(printf '%s\n' "$OUTPUT" | sed '/^[[:space:]]*$/d' | tail -n 3 | tr '\n' ' ' | cut -c1-260)
  {
    echo ""
    echo "## Run $RUN_NUMBER - $TODAY - FAILED"
    echo ""
    echo "**Failure:** [run failed - codex exited $CODEX_EXIT] ${FAILURE_DETAIL:-no output before exit}"
    echo "**Output:** Full stdout saved to $STDOUT_FILE"
  } >> "$LOG_FILE"
elif ! grep -qE "^## Run $RUN_NUMBER[[:space:]]+[—-]" "$LOG_FILE"; then
  {
    echo ""
    echo "## Run $RUN_NUMBER - $TODAY - ${RUN_TYPE^^}"
    echo ""
    echo "**Done:** Codex completed but did not append a run summary."
    echo "**Output:** Full stdout saved to $STDOUT_FILE"
    echo "**Next move:** Ask the next run to append a concise summary to reports/RUN_LOG.md."
  } >> "$LOG_FILE"
fi

python3 - "$LOG_FILE" "$RECENT_FILE" << 'PYEOF'
import sys, re

log_path, recent_path = sys.argv[1], sys.argv[2]
try:
    text = open(log_path).read()
except FileNotFoundError:
    text = ""

sections = re.split(r"(?=^## Run \d)", text, flags=re.MULTILINE)
runs = [s.strip() for s in sections if s.strip().startswith("## Run")]
recent = runs[-4:] if len(runs) >= 4 else runs

with open(recent_path, "w") as f:
    f.write("# Recent Runs\n\n")
    f.write("*Auto-generated. Last 4 runs. Full history in RUN_LOG.md.*\n\n---\n\n")
    f.write("\n\n---\n\n".join(recent) if recent else "*(no runs yet)*\n")
PYEOF

node - "$STATUS_PATH" "$RUN_TYPE" "$TODAY" "$CODEX_EXIT" "$RUN_NUMBER" << 'NODEEOF'
const fs = require('fs')
const [path, runType, today, exitCode, runNumber] = process.argv.slice(2)
try {
  const status = JSON.parse(fs.readFileSync(path, 'utf8'))
  status.runner = status.runner || 'codex'
  status.runCount = Number(runNumber)
  status.lastRun = today
  status.lastRunType = runType.toUpperCase()
  status.lastRunStatus = exitCode === '0' ? 'ok' : 'failed'
  fs.writeFileSync(path, JSON.stringify(status, null, 2) + '\n')
} catch (err) {
  console.error(`[codex-incubator] warning: could not update status: ${err.message}`)
}
NODEEOF

echo "[codex-incubator] done"
