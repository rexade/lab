#!/bin/bash
# run-codex-incubator.sh - generic Codex runner for the mounted Pi Pulse project
# Reads /home/admin/lab/projects/mounted.json unless a status.json path is passed.

set -euo pipefail

# Refuse to run when the disk is nearly full — a wedged run can otherwise fill
# the SD card and take down every service on the Pi.
MIN_FREE_MB=${MIN_FREE_MB:-2048}
FREE_MB=$(df -Pm /home/admin | awk 'NR==2 {print $4}')
if [ "${FREE_MB:-0}" -lt "$MIN_FREE_MB" ]; then
  echo "[codex-incubator] aborting: only ${FREE_MB}MB free on / (need ${MIN_FREE_MB}MB)" >&2
  exit 75
fi

LAB_DIR=${LAB_DIR:-/home/admin/lab}
APP_EVIDENCE_SCRIPT=${APP_EVIDENCE_SCRIPT:-$LAB_DIR/src/pi-pulse/scripts/app-evidence.mjs}
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
INCUBATOR_ROLE=$(node -e "const fs=require('fs'); const o=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(o.incubatorRole || o.role || '')" "$STATUS_PATH")
GLOBAL_LEARNING_LOG=${GLOBAL_LEARNING_LOG:-$LAB_DIR/INCUBATOR_LEARNINGS.md}
BENCHMARK_SUITE_FILE=${BENCHMARK_SUITE_FILE:-$LAB_DIR/BENCHMARK_SUITE.md}

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
RECOVERY_REQUIRED=0
RECOVERY_BLOCK=""
if [ -f "$FEEDBACK_FILE" ]; then
  FEEDBACK_TEXT=$(tail -n 80 "$FEEDBACK_FILE" || true)
  if [ -n "$FEEDBACK_TEXT" ]; then
    FEEDBACK_BLOCK=$(printf '\n\nUSER FEEDBACK / STEERING NOTES:\n%s' "$FEEDBACK_TEXT")
    if printf '%s\n' "$FEEDBACK_TEXT" | grep -Eiq "ugly|confus|broken|crash|not working|insufficient|worse|terrible|abomination|1/10|degraded|clutter|bloat|cant understand|cannot understand|can't understand|does nothing|nothing happened|not great|better off|better of"; then
      RECOVERY_REQUIRED=1
      RECOVERY_BLOCK=$(printf '\n\nQUALITY RECOVERY MODE TRIGGERED:\n- Latest feedback is negative about product quality or usability.\n- Do not add features, modes, panels, lore, or extra explanation before fixing the complaint.\n- Identify the smallest user-visible failure in the first screen or main workflow.\n- Prefer deletion, simplification, restyling, or rebuilding the failing path.\n- For UI/app work, verify open path, first-screen clarity, primary action, and visible main-workflow state change.\n- Do not write Quality gate: PASS unless evidence explicitly proves the complaint path is fixed.\n- The RUN_LOG entry must include **Recovery mode:** yes - [complaint addressed].')
    fi
  fi
fi
APP_EVIDENCE_REPAIR_BLOCK=$(node - "$STATUS_PATH" << 'NODEEOF'
const fs = require('fs')
try {
  const status = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  const gate = String(status.lastAppEvidenceGate || '').toUpperCase()
  const mode = status.lastAppEvidenceMode || null
  const topTier = status.lastAppEvidenceTopTier === true
  const primary = status.lastAppEvidencePrimaryAction || {}
  const success = status.lastAppEvidenceSemanticSuccess || {}
  const summary = status.lastAppEvidenceSummary || ''
  const path = status.lastAppEvidencePath || ''
  const evidenceUnavailable = mode === 'unavailable'
  const applies = gate && !evidenceUnavailable && (gate !== 'PASS' || mode === 'degraded' || !topTier)
  if (!applies) process.exit(0)

  const lines = [
    '',
    'APP EVIDENCE REPAIR REQUIRED:',
    `- Previous app evidence gate: ${gate || 'unknown'}.`,
    mode ? `- Previous evidence mode: ${mode}; top-tier eligible: ${topTier ? 'yes' : 'no'}.` : null,
    path ? `- Evidence summary: ${path}.` : null,
    summary ? `- Evidence note: ${summary.slice(0, 500)}` : null,
    primary?.source ? `- Previous primary action source: ${primary.source}; selector: ${primary.selector || 'none'}; changed: ${primary.changed ? 'yes' : 'no'}; visible/available: ${primary.available ? 'yes' : 'no'}.` : null,
    success?.available ? `- Previous semantic success contract: ${success.passed ? 'passed' : 'failed'}.` : '- Previous semantic success contract: missing.',
    '- Before adding features, fix the app evidence failure/degraded state.',
    '- For web/static/React apps, register window.__PI_PULSE_APP__ with a visible primaryAction.selector, a machine-checkable expect success contract, and reset/snapshot where practical.',
    '- If a hidden or secondary control was selected as primary, make the real first user action explicit with data-primary-action and keep hidden/debug controls out of the primary path.',
    '- If contrast/readability feedback exists, fix visible color contrast before tuning content or adding UI.',
    '- Do not claim Quality gate: PASS unless app evidence passes. Do not claim 4.5+ unless top-tier eligible semantic evidence passes.',
  ].filter(Boolean)
  console.log(lines.join('\n'))
} catch {}
NODEEOF
)
ROLE_BLOCK=""
if [ "$INCUBATOR_ROLE" = "signal-feeder" ]; then
  ROLE_BLOCK=$(printf '

INCUBATOR ROLE: signal feeder for Pi Pulse.
- This project exists partly to improve Pi Pulse and future incubators.
- Keep the app small enough to produce clear signal.
- Prefer metrics, user-choice evidence, failure patterns, and before/after comparisons over vague prose.
- When a reusable lesson exists, append these fields to reports/RUN_LOG.md:
**Pi Pulse lesson:** [one portable lesson future incubators should reuse]
**Learning evidence:** [metric, user observation, screenshot, test, or app-evidence result]
**Applies to future apps:** yes/no - [scope]')
fi
GLOBAL_LEARNING_BLOCK=""
if [ -f "$GLOBAL_LEARNING_LOG" ]; then
  GLOBAL_LEARNING_TEXT=$(tail -n 80 "$GLOBAL_LEARNING_LOG" || true)
  if [ -n "$GLOBAL_LEARNING_TEXT" ]; then
    GLOBAL_LEARNING_BLOCK=$(printf '

GLOBAL INCUBATOR LEARNINGS (apply when relevant, do not blindly copy):
%s' "$GLOBAL_LEARNING_TEXT")
  fi
fi
BENCHMARK_SUITE_BLOCK=""
if [ "$INCUBATOR_ROLE" = "signal-feeder" ] && [ -f "$BENCHMARK_SUITE_FILE" ]; then
  BENCHMARK_SUITE_TEXT=$(cat "$BENCHMARK_SUITE_FILE" || true)
  if [ -n "$BENCHMARK_SUITE_TEXT" ]; then
    BENCHMARK_SUITE_BLOCK=$(printf '

PI PULSE BENCHMARK SUITE:
%s' "$BENCHMARK_SUITE_TEXT")
  fi
fi
FULL_PROMPT=$(printf 'Run number: %s\nRun date: %s\nRun type: %s\n\n%s%s%s%s%s%s' "$RUN_NUMBER" "$TODAY" "$RUN_TYPE" "$(cat "$PROMPT_FILE")" "$ROLE_BLOCK" "$BENCHMARK_SUITE_BLOCK" "$GLOBAL_LEARNING_BLOCK" "$FEEDBACK_BLOCK" "$RECOVERY_BLOCK$APP_EVIDENCE_REPAIR_BLOCK")
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

# Hard cap on run duration: a hung codex process otherwise stays alive forever,
# holding memory and blocking every future scheduled run for this slot (the
# scheduler skips slots whose tracked PID is still alive).
CODEX_TIMEOUT=${CODEX_TIMEOUT:-2400}
OUTPUT=$(timeout -k 60 "$CODEX_TIMEOUT" "$CODEX_BIN" "${CODEX_ARGS[@]}" "$FULL_PROMPT" 2>&1) || CODEX_EXIT=$?

if [ "$CODEX_EXIT" -eq 124 ] || [ "$CODEX_EXIT" -eq 137 ]; then
  OUTPUT="[run failed - codex killed after ${CODEX_TIMEOUT}s timeout]

$OUTPUT"
elif [ "$CODEX_EXIT" -ne 0 ]; then
  OUTPUT="[run failed - codex exited $CODEX_EXIT]

$OUTPUT"
fi

STDOUT_DIR="$(dirname "$LOG_FILE")/stdout"
STDOUT_FILE="$STDOUT_DIR/codex-run-$RUN_NUMBER.log"
mkdir -p "$STDOUT_DIR"
printf '%s\n' "$OUTPUT" > "$STDOUT_FILE"

# Keep the transcript dir bounded: ~1MB per run × 48 runs/day fills the SD
# card otherwise. Newest 10 stay readable, older ones gzip, cap at 200 files.
ls -t "$STDOUT_DIR"/*-run-*.log 2>/dev/null | tail -n +11 | xargs -r gzip -f 2>/dev/null || true
ls -t "$STDOUT_DIR" 2>/dev/null | tail -n +201 | while read -r old; do rm -f "$STDOUT_DIR/$old"; done
# Codex CLI also writes a full session rollout per run under ~/.codex/sessions.
find "$HOME/.codex/sessions" -type f -mtime +14 -delete 2>/dev/null || true
find "$HOME/.codex/sessions" -type d -empty -delete 2>/dev/null || true

if [ "$CODEX_EXIT" -ne 0 ]; then
  FAILURE_DETAIL=$(printf '%s\n' "$OUTPUT" | sed '/^[[:space:]]*$/d' | tail -n 3 | tr '\n' ' ' | cut -c1-260)
  {
    echo ""
    echo "## Run $RUN_NUMBER - $TODAY - FAILED"
    echo ""
    echo "**Failure:** [run failed - codex exited $CODEX_EXIT] ${FAILURE_DETAIL:-no output before exit}"
    echo "**Output:** Full stdout saved to $STDOUT_FILE"
    echo "**Quality gate:** FAIL"
    echo "**Quality rating:** 0/5"
    echo "**Evidence confidence:** 2/5"
    echo "**Risk / regression:** Runner failed before a verified product-quality check could complete."
  } >> "$LOG_FILE"
elif ! grep -qE "^## Run $RUN_NUMBER[[:space:]]+[—-]" "$LOG_FILE"; then
  {
    echo ""
    echo "## Run $RUN_NUMBER - $TODAY - ${RUN_TYPE^^}"
    echo ""
    echo "**Done:** Codex completed but did not append a run summary."
    echo "**Evidence:** Full stdout saved to $STDOUT_FILE; no structured quality summary was appended."
    echo "**Output:** Full stdout saved to $STDOUT_FILE"
    echo "**Quality gate:** NEEDS-EVIDENCE"
    echo "**Quality rating:** 1/5"
    echo "**Evidence confidence:** 1/5"
    echo "**Risk / regression:** Runner completed, but the run did not report acceptance evidence."
    echo "**Next move:** Ask the next run to append a concise summary and quality gate to reports/RUN_LOG.md."
  } >> "$LOG_FILE"
fi

APP_EVIDENCE_JSON=""
if [ -f "$APP_EVIDENCE_SCRIPT" ] && { [ -f "$PROJECT_DIR/index.html" ] || [ -f "$PROJECT_DIR/package.json" ]; }; then
  APP_EVIDENCE_OUTPUT=$(node "$APP_EVIDENCE_SCRIPT" --repo "$PROJECT_DIR" --run "$RUN_NUMBER" --type "$RUN_TYPE" 2>&1) || true
  APP_EVIDENCE_JSON="$PROJECT_DIR/reports/evidence/run-$RUN_NUMBER/summary.json"
  APP_EVIDENCE_MD="$PROJECT_DIR/reports/evidence/run-$RUN_NUMBER/summary.md"
  {
    echo "**App evidence:** ${APP_EVIDENCE_MD}"
    if [ -n "${APP_EVIDENCE_OUTPUT:-}" ]; then
      echo "**App evidence output:** ${APP_EVIDENCE_OUTPUT}"
    fi
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

node - "$LOG_FILE" "$RUN_NUMBER" "$STDOUT_FILE" "$APP_EVIDENCE_JSON" "$CODEX_EXIT" << 'NODEEOF'
const fs = require('fs')
const [logPath, runNumber, stdoutFile, appEvidencePath, exitCode] = process.argv.slice(2)
function latestRunBlock(text, runNumber) {
  const sections = text.split(/(?=^## Run \d+)/m).filter(section => section.trimStart().startsWith(`## Run ${runNumber} `))
  return sections[sections.length - 1] || ''
}
function readEvidence(filePath) {
  if (!filePath) return null
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { return null }
}
try {
  const text = fs.readFileSync(logPath, 'utf8')
  const block = latestRunBlock(text, runNumber)
  if (!block || /^\*\*Quality gate:\*\*/m.test(block)) process.exit(0)
  const evidence = readEvidence(appEvidencePath)
  const evidenceGate = String(evidence?.gate || '').toUpperCase()
  const gate = exitCode === '0'
    ? evidenceGate === 'FAIL' ? 'FAIL' : 'NEEDS-EVIDENCE'
    : 'FAIL'
  const rating = gate === 'FAIL' ? '2/5' : evidenceGate === 'PASS' ? '3/5' : '1/5'
  const confidence = evidence ? (evidenceGate === 'PASS' ? '3/5' : '4/5') : '1/5'
  const appEvidenceLine = evidence?.summaryMdPath || evidence?.summaryPath || appEvidencePath || 'not available'
  const risk = gate === 'FAIL'
    ? 'Runner fallback found missing quality fields and app evidence failed or the runner failed.'
    : 'Runner fallback found missing quality fields; product quality cannot be trusted until the next run reports acceptance evidence.'
  fs.appendFileSync(logPath, [
    '',
    '**Acceptance check:** Runner fallback - required quality fields were missing from this run summary.',
    `**Evidence:** Full stdout saved to ${stdoutFile}; app evidence: ${appEvidenceLine}`,
    '**North star:** UNCLEAR - runner fallback could not read a first-class north star.',
    '**Strategy:** Repair the missing run contract before trusting product-quality claims.',
    '**Why this run type:** Fallback generated after the selected runner omitted required fields.',
    '**Expected quality delta:** Restore measurable run strategy and evidence fields.',
    '**Actual quality delta:** none measured - required fields were missing.',
    '**Plateau/regression verdict:** UNCLEAR - missing strategy and quality fields.',
    `**Quality gate:** ${gate}`,
    `**Quality rating:** ${rating}`,
    `**Evidence confidence:** ${confidence}`,
    `**Risk / regression:** ${risk}`,
    '**Next move:** Run a focused mutate pass that addresses the app evidence failure and writes the required quality fields.',
    '',
  ].join('\n'))
} catch (err) {
  console.error(`[incubator] warning: could not append missing quality fallback: ${err.message}`)
}
NODEEOF

node - "$STATUS_PATH" "$RUN_TYPE" "$TODAY" "$CODEX_EXIT" "$RUN_NUMBER" "$LOG_FILE" "$RECOVERY_REQUIRED" "$APP_EVIDENCE_JSON" << 'NODEEOF'
const fs = require('fs')
const [path, runType, today, exitCode, runNumber, logPath, recoveryRequired, appEvidencePath] = process.argv.slice(2)
function latestRunFields(logPath, runNumber) {
  try {
    const text = fs.readFileSync(logPath, 'utf8')
    const sections = text.split(/(?=^## Run \d+)/m).filter(section => section.trimStart().startsWith(`## Run ${runNumber} `))
    const block = sections[sections.length - 1] || ''
    const fields = {}
    for (const line of block.split('\n')) {
      const match = line.match(/^\*\*(.+?):\*\*\s*(.*)$/)
      if (match) fields[match[1].trim()] = match[2].trim()
    }
    return fields
  } catch { return {} }
}
function gate(value) {
  const raw = String(value || '').trim().toUpperCase().replace(/[_.\s]+/g, '-')
  if (raw.startsWith('PASS')) return 'PASS'
  if (raw.startsWith('FAIL')) return 'FAIL'
  if (raw.includes('NEEDS-EVIDENCE') || raw.includes('NEED-EVIDENCE') || raw.includes('INSUFFICIENT-EVIDENCE')) return 'NEEDS-EVIDENCE'
  return null
}
function score(value) {
  const match = String(value || '').match(/(\d+(?:\.\d+)?)\s*\/\s*5/)
  return match ? Math.max(0, Math.min(5, Number(match[1]))) : null
}
function readAppEvidence(filePath) {
  if (!filePath) return null
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { return null }
}
try {
  const status = JSON.parse(fs.readFileSync(path, 'utf8'))
  const runnerOk = exitCode === '0'
  const fields = latestRunFields(logPath, runNumber)
  const appEvidence = readAppEvidence(appEvidencePath)
  const appEvidenceGate = gate(appEvidence?.gate)
  const appEvidenceApplies = !!appEvidence && appEvidence.appType && appEvidence.appType !== 'unknown'
  let qualityGate = runnerOk ? (gate(fields['Quality gate']) || 'NEEDS-EVIDENCE') : 'FAIL'
  if (runnerOk && appEvidenceApplies && appEvidenceGate === 'FAIL') qualityGate = 'FAIL'
  if (runnerOk && appEvidenceApplies && qualityGate === 'PASS' && appEvidenceGate !== 'PASS') qualityGate = 'NEEDS-EVIDENCE'
  status.runner = status.runner || 'codex'
  status.runCount = Number(runNumber)
  status.lastRun = today
  status.lastRunType = runType.toUpperCase()
  status.lastRunnerStatus = runnerOk ? 'ok' : 'failed'
  status.lastQualityGate = qualityGate
  status.lastQualityRating = score(fields['Quality rating'])
  if (status.lastQualityRating != null && appEvidenceApplies && appEvidenceGate !== 'PASS') {
    status.lastQualityRating = Math.min(status.lastQualityRating, appEvidenceGate === 'FAIL' ? 2 : 3)
  }
  if (status.lastQualityRating != null && appEvidenceApplies && appEvidenceGate === 'PASS' && appEvidence?.topTierEligible !== true) {
    status.lastQualityRating = Math.min(status.lastQualityRating, 4)
  }
  status.lastEvidenceConfidence = score(fields['Evidence confidence'])
  status.lastQualitySummary = (fields['Evidence'] || fields['Acceptance check'] || fields['Risk / regression'] || (runnerOk ? 'Latest run did not report a quality gate.' : fields['Failure']) || '').slice(0, 360) || null
  status.lastNorthStar = (fields['North star'] || '').slice(0, 500) || null
  status.lastRunStrategy = (fields['Strategy'] || '').slice(0, 500) || null
  status.lastWhyRunType = (fields['Why this run type'] || '').slice(0, 500) || null
  status.lastExpectedQualityDelta = (fields['Expected quality delta'] || '').slice(0, 500) || null
  status.lastActualQualityDelta = (fields['Actual quality delta'] || '').slice(0, 500) || null
  status.lastPlateauRegressionVerdict = (fields['Plateau/regression verdict'] || '').slice(0, 300) || null
  status.lastRecoveryRequired = recoveryRequired === '1'
  status.lastRecoveryMode = fields['Recovery mode'] || (status.lastRecoveryRequired ? 'yes - negative feedback trigger' : null)
  status.lastAppEvidencePath = appEvidence?.summaryMdPath || appEvidence?.summaryPath || null
  status.lastAppEvidenceGate = appEvidenceGate
  status.lastAppEvidenceTopTier = appEvidence?.topTierEligible === true
  status.lastAppEvidenceMode = appEvidence?.evidenceMode || null
  status.lastAppEvidencePrimaryAction = appEvidence?.primaryAction || null
  status.lastAppEvidenceSemanticSuccess = appEvidence?.semanticSuccess || null
  status.lastAppEvidenceSummary = appEvidence?.notes?.join(' ').slice(0, 360) || null
  status.lastRunStatus = runnerOk ? (qualityGate === 'PASS' ? 'ok' : qualityGate === 'FAIL' ? 'quality-failed' : 'needs-evidence') : 'failed'
  fs.writeFileSync(path, JSON.stringify(status, null, 2) + '\n')
} catch (err) {
  console.error(`[codex-incubator] warning: could not update status: ${err.message}`)
}
NODEEOF

node - "$STATUS_PATH" "$PROJECT" "$RUN_NUMBER" "$TODAY" "$LOG_FILE" "$GLOBAL_LEARNING_LOG" << 'NODEEOF'
const fs = require('fs')
const [statusPath, project, runNumber, today, logPath, globalLearningLog] = process.argv.slice(2)
function latestRunFields(logPath, runNumber) {
  try {
    const text = fs.readFileSync(logPath, 'utf8')
    const sections = text.split(/(?=^## Run \d+)/m).filter(section => section.trimStart().startsWith(`## Run ${runNumber} `))
    const block = sections[sections.length - 1] || ''
    const fields = {}
    for (const line of block.split('\n')) {
      const match = line.match(/^\*\*(.+?):\*\*\s*(.*)$/)
      if (match) fields[match[1].trim()] = match[2].trim()
    }
    return fields
  } catch { return {} }
}
try {
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'))
  const role = status.incubatorRole || status.role || 'product'
  const fields = latestRunFields(logPath, runNumber)
  const lesson = fields['Pi Pulse lesson'] || ''
  if (!lesson || role !== 'signal-feeder') process.exit(0)
  const evidence = fields['Learning evidence'] || fields['Evidence'] || 'not recorded'
  const applies = fields['Applies to future apps'] || 'yes - scope not specified'
  const marker = `<!-- incubator-learning:${project}:${runNumber} -->`
  let existing = ''
  try { existing = fs.readFileSync(globalLearningLog, 'utf8') } catch {}
  if (existing.includes(marker)) process.exit(0)
  if (!existing.trim()) existing = '# Incubator Learnings\n\nPortable lessons produced by signal-feeder incubators. Future runs receive the tail of this file.\n'
  const entry = [
    '',
    marker,
    `## ${today} - ${project} run ${runNumber}`,
    `**Lesson:** ${lesson}`,
    `**Evidence:** ${evidence}`,
    `**Applies:** ${applies}`,
    '',
  ].join('\n')
  fs.writeFileSync(globalLearningLog, existing.replace(/\s*$/, '\n') + entry)
} catch (err) {
  console.error(`[codex-incubator] warning: could not harvest incubator learning: ${err.message}`)
}
NODEEOF

echo "[codex-incubator] done"
