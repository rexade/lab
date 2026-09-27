#!/usr/bin/env bash
# run-incubator.sh - the one runner for Pi Pulse incubator slots (Codex or Claude).
# Usage: run-incubator.sh <path/to/status.json> [create|mutate|research|harvest]
#
# The agent comes from $PI_PULSE_AGENT (set by the run-codex-incubator.sh /
# run-claude-incubator.sh shims) or else status.json "runner". JSON and
# RUN_LOG.md handling lives in lib/incubator-run.mjs.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RUN_HELPER="$SCRIPT_DIR/lib/incubator-run.mjs"
LAB_DIR=${LAB_DIR:-$(cd "$SCRIPT_DIR/../../.." && pwd)}
APP_EVIDENCE_SCRIPT=${APP_EVIDENCE_SCRIPT:-$SCRIPT_DIR/app-evidence.mjs}

# systemd starts runs with a minimal environment; fill gaps without clobbering.
export HOME=${HOME:-/home/admin}
export USER=${USER:-$(id -un)}
export LOGNAME=${LOGNAME:-$USER}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
export XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
export XDG_CACHE_HOME=${XDG_CACHE_HOME:-$HOME/.cache}
export XDG_DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:${PATH:-/usr/local/bin:/usr/bin:/bin}"

TAG="[${PI_PULSE_AGENT:+$PI_PULSE_AGENT-}incubator]"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
TODAY=$(date '+%Y-%m-%d')
STATUS_PATH=${1:-}

if [ -z "$STATUS_PATH" ] || [ ! -f "$STATUS_PATH" ]; then
  echo "$TAG missing status.json path" >&2
  exit 2
fi

CONFIG=$(node "$RUN_HELPER" config "$STATUS_PATH")
declare -A CFG=()
while IFS='=' read -r key value; do
  [ -n "$key" ] && CFG[$key]=$value
done <<< "$CONFIG"

AGENT=${CFG[agent]}
TAG="[$AGENT-incubator]"
PROJECT=${CFG[project]}
PROJECT_DIR=${CFG[repo]}
LOG_FILE=${CFG[runLog]}
PROMPT_DIR=${CFG[promptDir]}
RECENT_FILE=${CFG[recentRuns]}
FEEDBACK_FILE=${CFG[feedbackPath]}
BYPASS=${CFG[bypass]}
read -r -a RUN_TYPES <<< "${CFG[runTypes]}"

# Refuse to run when the disk is nearly full — a wedged run can otherwise fill
# the SD card and take down every service on the Pi.
MIN_FREE_MB=${MIN_FREE_MB:-2048}
FREE_MB=$(df -Pm "$PROJECT_DIR" 2>/dev/null | awk 'NR==2 {print $4}' || true)
if [ -n "$FREE_MB" ] && [ "$FREE_MB" -lt "$MIN_FREE_MB" ]; then
  echo "$TAG aborting: only ${FREE_MB}MB free for $PROJECT_DIR (need ${MIN_FREE_MB}MB)" >&2
  exit 75
fi

if [ "$AGENT" = "claude" ]; then
  CLAUDE_BIN=${CLAUDE_BIN:-$(command -v claude || true)}
  if [ -z "$CLAUDE_BIN" ]; then
    echo "$TAG claude binary not found; install Claude Code or add claude to PATH" >&2
    exit 127
  fi
  if [ ! -x "$CLAUDE_BIN" ]; then
    echo "$TAG configured claude binary is not executable: $CLAUDE_BIN" >&2
    exit 127
  fi
  AGENT_BIN=$CLAUDE_BIN
  AGENT_TIMEOUT=${CLAUDE_TIMEOUT:-2400}
  AGENT_LABEL=Claude
else
  CODEX_BIN=${CODEX_BIN:-$HOME/.npm-global/bin/codex}
  if [ ! -x "$CODEX_BIN" ]; then
    CODEX_BIN=$(command -v codex || true)
  fi
  if [ -z "$CODEX_BIN" ] || [ ! -x "$CODEX_BIN" ]; then
    echo "$TAG codex binary not found; set CODEX_BIN or add codex to PATH" >&2
    exit 127
  fi
  AGENT_BIN=$CODEX_BIN
  AGENT_TIMEOUT=${CODEX_TIMEOUT:-2400}
  AGENT_LABEL=Codex
fi

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$RECENT_FILE")"
touch "$LOG_FILE"

LAST_RUN=$(grep -oE "^## Run [0-9]+" "$LOG_FILE" 2>/dev/null | grep -oE "[0-9]+" | sort -n | tail -1 || true)
RUN_COUNT=${LAST_RUN:-0}
if [ "${CFG[runCount]}" -gt "$RUN_COUNT" ]; then
  RUN_COUNT=${CFG[runCount]}
fi
RUN_NUMBER=$((RUN_COUNT + 1))

REQUESTED_TYPE=${2:-}
if [[ "$REQUESTED_TYPE" =~ ^(create|mutate|research|harvest)$ ]] && [ -f "$PROMPT_DIR/$REQUESTED_TYPE.md" ]; then
  RUN_TYPE="$REQUESTED_TYPE"
else
  RUN_TYPE="${RUN_TYPES[$((RUN_COUNT % ${#RUN_TYPES[@]}))]}"
fi

PROMPT_FILE="$PROMPT_DIR/$RUN_TYPE.md"
if [ ! -f "$PROMPT_FILE" ]; then
  echo "$TAG missing prompt: $PROMPT_FILE" >&2
  exit 1
fi

if [ "$AGENT" = "codex" ] && [ -n "${CFG[godotAiEnabled]}" ]; then
  GODOT_AI_ENABLED=${CFG[godotAiEnabled]}
  GODOT_AI_MCP_URL=${CFG[godotAiMcpUrl]}
  GODOT_AI_STATUS_URL=${CFG[godotAiStatusUrl]}
  GODOT_AI_VERSION=${CFG[godotAiVersion]}
  GODOT_AI_LOG=${CFG[godotAiLog]}
  # shellcheck source=lib/godot-ai-bridge.sh
  . "$SCRIPT_DIR/lib/godot-ai-bridge.sh"
  ensure_godot_ai_bridge
fi

echo "$TAG $TIMESTAMP - starting $PROJECT $RUN_TYPE run (#$RUN_NUMBER)"

node "$RUN_HELPER" recent-runs "$LOG_FILE" "$RECENT_FILE"

cd "$PROJECT_DIR"

# --- Prompt assembly (identical for every agent) ---------------------------
FEEDBACK_BLOCK=""
RECOVERY_REQUIRED=0
RECOVERY_BLOCK=""
if [ -f "$FEEDBACK_FILE" ]; then
  FEEDBACK_TEXT=$(tail -n 80 "$FEEDBACK_FILE" || true)
  if [ -n "$FEEDBACK_TEXT" ]; then
    FEEDBACK_BLOCK=$(printf '\n\nUSER FEEDBACK / STEERING NOTES:\n%s' "$FEEDBACK_TEXT")
    # Recovery answers the newest note only: an old complaint the person has
    # since replied to must not keep every later run in recovery mode.
    LATEST_NOTE=$(node "$RUN_HELPER" latest-note "$FEEDBACK_FILE" || true)
    if printf '%s\n' "$LATEST_NOTE" | grep -Eiq "ugly|confus|broken|crash|not working|insufficient|worse|terrible|abomination|1/10|degraded|clutter|bloat|cant understand|cannot understand|can't understand|does nothing|nothing happened|not great|better off|better of"; then
      RECOVERY_REQUIRED=1
      RECOVERY_BLOCK=$(printf '\n\nQUALITY RECOVERY MODE TRIGGERED:\n- Latest feedback is negative about product quality or usability.\n- Do not add features, modes, panels, lore, or extra explanation before fixing the complaint.\n- Identify the smallest user-visible failure in the first screen or main workflow.\n- Prefer deletion, simplification, restyling, or rebuilding the failing path.\n- For UI/app work, verify open path, first-screen clarity, primary action, and visible main-workflow state change.\n- Do not write Quality gate: PASS unless evidence explicitly proves the complaint path is fixed.\n- The RUN_LOG entry must include **Recovery mode:** yes - [complaint addressed].')
    fi
  fi
fi

APP_EVIDENCE_REPAIR_BLOCK=$(node "$RUN_HELPER" repair-block "$STATUS_PATH")

# How every run works, whatever its type. Runs are unattended: nothing here asks
# a person for anything.
OPERATING_BLOCK=$(printf '

OPERATING RULES (every run):
- You own this run end to end: choose one problem, investigate it, change it, verify the change against the running app or its tests, then report.
- Report only what you verified. Mark anything you could not check as unverified. Do not invent problems or passes.
- Nobody is watching and nobody can be asked. Decide product questions yourself. If something is out of reach (credentials, hardware, sudo, system services, anything outside this project folder), design around it and keep going.')

FULL_PROMPT=$(printf 'Run number: %s\nRun date: %s\nRun type: %s\n\n%s%s%s%s' "$RUN_NUMBER" "$TODAY" "$RUN_TYPE" "$(cat "$PROMPT_FILE")" "$OPERATING_BLOCK" "$FEEDBACK_BLOCK" "$RECOVERY_BLOCK$APP_EVIDENCE_REPAIR_BLOCK")

# --- Agent invocation --------------------------------------------------------
if [ "$AGENT" = "claude" ]; then
  CLAUDE_MODEL=${CFG[claudeModel]}
  CLAUDE_ARGS=(-p "$FULL_PROMPT")
  if [ -n "$CLAUDE_MODEL" ]; then
    CLAUDE_ARGS+=(--model "$CLAUDE_MODEL")
    # An unavailable or retired pin degrades to the stable alias instead of failing the run.
    if [ "$CLAUDE_MODEL" != "sonnet" ]; then
      CLAUDE_ARGS+=(--fallback-model sonnet)
    fi
  fi
  # Headless runs cannot answer permission prompts, so name the mode explicitly;
  # without it every edit and shell command is denied.
  if [ -n "$BYPASS" ]; then
    CLAUDE_ARGS+=(--dangerously-skip-permissions)
  else
    CLAUDE_ARGS+=(--permission-mode "${CFG[claudePermissionMode]:-auto}")
  fi
  AGENT_ARGS=("${CLAUDE_ARGS[@]}")
else
  CLAUDE_MODEL=""
  CODEX_MODEL=${CFG[codexModel]}
  CODEX_ARGS=(exec -C "$PROJECT_DIR" --color never)
  if [ -n "$BYPASS" ]; then
    CODEX_ARGS+=("--dangerously-bypass-approvals-and-sandbox")
  else
    CODEX_ARGS+=("--sandbox" "workspace-write")
  fi
  if [ -n "$CODEX_MODEL" ]; then
    CODEX_ARGS+=("--model" "$CODEX_MODEL")
  fi
  AGENT_ARGS=("${CODEX_ARGS[@]}" "$FULL_PROMPT")
fi

# Hard cap on run duration: a hung agent otherwise stays alive forever, holding
# memory and blocking every future scheduled run for this slot (the scheduler
# skips slots whose tracked PID is still alive).
AGENT_EXIT=0
OUTPUT=$(timeout -k 60 "$AGENT_TIMEOUT" "$AGENT_BIN" "${AGENT_ARGS[@]}" 2>&1) || AGENT_EXIT=$?

if [ "$AGENT_EXIT" -eq 124 ] || [ "$AGENT_EXIT" -eq 137 ]; then
  OUTPUT="[run failed - $AGENT killed after ${AGENT_TIMEOUT}s timeout]

$OUTPUT"
elif [ "$AGENT_EXIT" -ne 0 ]; then
  OUTPUT="[run failed - $AGENT exited $AGENT_EXIT]

$OUTPUT"
fi

STDOUT_DIR="$(dirname "$LOG_FILE")/stdout"
STDOUT_FILE="$STDOUT_DIR/$AGENT-run-$RUN_NUMBER.log"
mkdir -p "$STDOUT_DIR"
printf '%s\n' "$OUTPUT" > "$STDOUT_FILE"

# Keep the transcript dir bounded: ~1MB per run × 48 runs/day fills the SD
# card otherwise. Newest 10 stay readable, older ones gzip, cap at 200 files.
ls -t "$STDOUT_DIR"/*-run-*.log 2>/dev/null | tail -n +11 | xargs -r gzip -f 2>/dev/null || true
ls -t "$STDOUT_DIR" 2>/dev/null | tail -n +201 | while read -r old; do rm -f "$STDOUT_DIR/$old"; done
# Do not prune ~/.codex/sessions here. That is global user-owned Codex history,
# not a Pi Pulse project cache. Pi Pulse only manages transcripts under reports/stdout.

# --- RUN_LOG receipts ----------------------------------------------------------
if [ "$AGENT_EXIT" -ne 0 ]; then
  FAILURE_DETAIL=$(printf '%s\n' "$OUTPUT" | sed '/^[[:space:]]*$/d' | tail -n 3 | tr '\n' ' ' | cut -c1-260)
  {
    echo ""
    echo "## Run $RUN_NUMBER - $TODAY - FAILED"
    echo ""
    echo "**Failure:** [run failed - $AGENT exited $AGENT_EXIT] ${FAILURE_DETAIL:-no output before exit}"
    echo "**Output:** Full stdout saved to $STDOUT_FILE"
    echo "**Quality gate:** FAIL"
    echo "**Quality rating:** 0/5"
    echo "**Evidence confidence:** 2/5"
    echo "**Risk / regression:** Runner failed before a verified product-quality check could complete."
  } >> "$LOG_FILE"
elif ! grep -qE "^## Run $RUN_NUMBER[[:space:]]+[—-]" "$LOG_FILE"; then
  OUTPUT_EXCERPT=$(printf '%s\n' "$OUTPUT" | sed '/^[[:space:]]*$/d' | head -n 6 | tr '\n' ' ' | cut -c1-420)
  {
    echo ""
    echo "## Run $RUN_NUMBER - $TODAY - ${RUN_TYPE^^}"
    echo ""
    echo "**Done:** $AGENT_LABEL completed but did not append a run summary."
    echo "**Output excerpt:** ${OUTPUT_EXCERPT:-no stdout captured}"
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

node "$RUN_HELPER" recent-runs "$LOG_FILE" "$RECENT_FILE"
node "$RUN_HELPER" quality-fallback "$LOG_FILE" "$RUN_NUMBER" "$STDOUT_FILE" "$APP_EVIDENCE_JSON" "$AGENT_EXIT"
node "$RUN_HELPER" update-status "$STATUS_PATH" "$RUN_TYPE" "$TODAY" "$AGENT_EXIT" "$RUN_NUMBER" "$LOG_FILE" "$RECOVERY_REQUIRED" "$APP_EVIDENCE_JSON" "$AGENT" "$CLAUDE_MODEL"

echo "$TAG done"
