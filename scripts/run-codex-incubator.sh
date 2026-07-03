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
CODEX_MODEL=$(node -e "const fs=require('fs'); const o=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(o.codexModel || process.env.CODEX_MODEL || '')" "$STATUS_PATH")
CODEX_BYPASS=$(node -e "const fs=require('fs'); const o=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(o.codexBypass || process.env.CODEX_BYPASS === '1' ? '1' : '')" "$STATUS_PATH")

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
FULL_PROMPT=$(printf 'Run number: %s\nRun date: %s\nRun type: %s\n\n%s' "$RUN_NUMBER" "$TODAY" "$RUN_TYPE" "$(cat "$PROMPT_FILE")")
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
