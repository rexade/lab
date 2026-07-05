#!/usr/bin/env bash
# Generic Claude runner for Pi Pulse incubator slots.
# Usage: run-claude-incubator.sh /home/admin/lab/projects/<project>/status.json [create|mutate|research|harvest]

set -euo pipefail

LAB_DIR=${LAB_DIR:-/home/admin/lab}
export HOME=${HOME:-/home/admin}
export USER=${USER:-admin}
export LOGNAME=${LOGNAME:-admin}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/1000}
export XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-/home/admin/.config}
export XDG_CACHE_HOME=${XDG_CACHE_HOME:-/home/admin/.cache}
export XDG_DATA_HOME=${XDG_DATA_HOME:-/home/admin/.local/share}
export PATH="/home/admin/.npm-global/bin:/home/admin/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"

TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
TODAY=$(date '+%Y-%m-%d')
STATUS_PATH=${1:-}

if [ -z "$STATUS_PATH" ] || [ ! -f "$STATUS_PATH" ]; then
  echo "[claude-incubator] missing status.json path" >&2
  exit 2
fi

CLAUDE_BIN=${CLAUDE_BIN:-$(command -v claude || true)}
if [ -z "$CLAUDE_BIN" ]; then
  echo "[claude-incubator] claude binary not found; install Claude Code or add claude to PATH" >&2
  exit 127
fi
if [ ! -x "$CLAUDE_BIN" ]; then
  echo "[claude-incubator] configured claude binary is not executable: $CLAUDE_BIN" >&2
  exit 127
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
CLAUDE_MODEL=$(node -e "const fs=require('fs'); const invalid=new Set(['fable','claude-sonnet-4-20250514']); const safe='sonnet'; const o=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const clean=v => v && !invalid.has(v) ? v : ''; const saved=clean(o.claudeModel); const env=clean(process.env.CLAUDE_MODEL); const fallback=clean(process.env.PI_PULSE_DEFAULT_CLAUDE_MODEL); console.log(saved || env || fallback || safe)" "$STATUS_PATH")
CLAUDE_BYPASS=$(node -e "const fs=require('fs'); const o=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(o.claudeBypass || process.env.CLAUDE_BYPASS === '1' ? '1' : '')" "$STATUS_PATH")

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
  echo "[claude-incubator] missing prompt: $PROMPT_FILE" >&2
  exit 1
fi

echo "[claude-incubator] $TIMESTAMP - starting $PROJECT $RUN_TYPE run (#$RUN_NUMBER)"

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
CLAUDE_EXIT=0
CLAUDE_ARGS=(-p "$FULL_PROMPT")
if [ -n "$CLAUDE_MODEL" ]; then
  CLAUDE_ARGS+=(--model "$CLAUDE_MODEL")
fi
if [ -n "$CLAUDE_BYPASS" ]; then
  CLAUDE_ARGS+=(--dangerously-skip-permissions)
fi

OUTPUT=$("$CLAUDE_BIN" "${CLAUDE_ARGS[@]}" 2>&1) || CLAUDE_EXIT=$?

if [ "$CLAUDE_EXIT" -ne 0 ]; then
  OUTPUT="[run failed - claude exited $CLAUDE_EXIT]

$OUTPUT"
fi

STDOUT_DIR="$(dirname "$LOG_FILE")/stdout"
STDOUT_FILE="$STDOUT_DIR/claude-run-$RUN_NUMBER.log"
mkdir -p "$STDOUT_DIR"
printf '%s\n' "$OUTPUT" > "$STDOUT_FILE"

if [ "$CLAUDE_EXIT" -ne 0 ]; then
  FAILURE_DETAIL=$(printf '%s\n' "$OUTPUT" | sed '/^[[:space:]]*$/d' | tail -n 3 | tr '\n' ' ' | cut -c1-260)
  {
    echo ""
    echo "## Run $RUN_NUMBER - $TODAY - FAILED"
    echo ""
    echo "**Failure:** [run failed - claude exited $CLAUDE_EXIT] ${FAILURE_DETAIL:-no output before exit}"
    echo "**Output:** Full stdout saved to $STDOUT_FILE"
  } >> "$LOG_FILE"
elif ! grep -qE "^## Run $RUN_NUMBER[[:space:]]+[—-]" "$LOG_FILE"; then
  OUTPUT_EXCERPT=$(printf '%s\n' "$OUTPUT" | sed '/^[[:space:]]*$/d' | head -n 6 | tr '\n' ' ' | cut -c1-420)
  {
    echo ""
    echo "## Run $RUN_NUMBER - $TODAY - ${RUN_TYPE^^}"
    echo ""
    echo "**Done:** Claude completed but did not append a run summary."
    echo "**Output excerpt:** ${OUTPUT_EXCERPT:-no stdout captured}"
    echo "**Output:** Full stdout saved to $STDOUT_FILE"
    echo "**Next move:** Ask the next run to append a concise summary to reports/RUN_LOG.md."
  } >> "$LOG_FILE"
fi

node - "$STATUS_PATH" "$RUN_TYPE" "$TODAY" "$CLAUDE_EXIT" "$RUN_NUMBER" "$CLAUDE_MODEL" << 'NODEEOF'
const fs = require('fs')
const [path, runType, today, exitCode, runNumber, model] = process.argv.slice(2)
try {
  const status = JSON.parse(fs.readFileSync(path, 'utf8'))
  status.runner = status.runner || 'claude'
  status.runCount = Number(runNumber)
  status.lastRun = today
  status.lastRunType = runType.toUpperCase()
  status.lastRunStatus = exitCode === '0' ? 'ok' : 'failed'
  if (model) status.claudeModel = model
  else delete status.claudeModel
  fs.writeFileSync(path, JSON.stringify(status, null, 2) + '\n')
} catch (err) {
  console.error(`[claude-incubator] warning: could not update status: ${err.message}`)
}
NODEEOF

echo "[claude-incubator] done"
