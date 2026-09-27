#!/usr/bin/env bash
# run-incubator.sh - one autonomous session for a Pi Pulse incubator (Codex or Claude).
# Usage: run-incubator.sh <path/to/status.json>
#
# A session is one agent owning one goal end to end:
#   session-begin   stage, git baseline, baseline checks        (lib/incubator-run.mjs)
#   agent           builds, runs and checks its own work        (this script)
#   session-end     lab checks, then keep (commit) or revert    (lib/incubator-run.mjs)
#   review          a fresh read-only agent judges the product  (this script + review-apply)
# The agent comes from $PI_PULSE_AGENT (set by the run-codex-incubator.sh /
# run-claude-incubator.sh shims) or else status.json "runner".

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RUN_HELPER="$SCRIPT_DIR/lib/incubator-run.mjs"
LAB_DIR=${LAB_DIR:-$(cd "$SCRIPT_DIR/../../.." && pwd)}
export APP_EVIDENCE_SCRIPT=${APP_EVIDENCE_SCRIPT:-$SCRIPT_DIR/app-evidence.mjs}

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

read_values() {
  local -n target=$1
  shift
  local output
  output=$("$@") || return $?
  while IFS='=' read -r key value; do
    [ -n "$key" ] && target[$key]=$value
  done <<< "$output"
}

declare -A CFG=()
read_values CFG node "$RUN_HELPER" config "$STATUS_PATH"

AGENT=${CFG[agent]}
REVIEWER=${CFG[reviewer]:-$AGENT}
TAG="[$AGENT-incubator]"
PROJECT=${CFG[project]}
PROJECT_DIR=${CFG[repo]}
LOG_FILE=${CFG[runLog]}
RECENT_FILE=${CFG[recentRuns]}
BYPASS=${CFG[bypass]}
CLAUDE_MODEL=${CFG[claudeModel]}
CODEX_MODEL=${CFG[codexModel]}

# Refuse to run when the disk is nearly full — a wedged run can otherwise fill
# the SD card and take down every service on the Pi.
MIN_FREE_MB=${MIN_FREE_MB:-2048}
FREE_MB=$(df -Pm "$PROJECT_DIR" 2>/dev/null | awk 'NR==2 {print $4}' || true)
if [ -n "$FREE_MB" ] && [ "$FREE_MB" -lt "$MIN_FREE_MB" ]; then
  echo "$TAG aborting: only ${FREE_MB}MB free for $PROJECT_DIR (need ${MIN_FREE_MB}MB)" >&2
  exit 75
fi

resolve_claude_bin() {
  local bin=${CLAUDE_BIN:-$(command -v claude || true)}
  [ -n "$bin" ] && [ -x "$bin" ] && printf '%s' "$bin"
}

resolve_codex_bin() {
  local bin=${CODEX_BIN:-$HOME/.npm-global/bin/codex}
  [ -x "$bin" ] || bin=$(command -v codex || true)
  [ -n "$bin" ] && [ -x "$bin" ] && printf '%s' "$bin"
}

if [ "$AGENT" = "claude" ]; then
  AGENT_BIN=$(resolve_claude_bin || true)
  if [ -z "$AGENT_BIN" ]; then
    echo "$TAG claude binary not found or not executable; install Claude Code or set CLAUDE_BIN" >&2
    exit 127
  fi
  AGENT_TIMEOUT=${CLAUDE_TIMEOUT:-2400}
  AGENT_LABEL=Claude
else
  AGENT_BIN=$(resolve_codex_bin || true)
  if [ -z "$AGENT_BIN" ]; then
    echo "$TAG codex binary not found; set CODEX_BIN or add codex to PATH" >&2
    exit 127
  fi
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

# --- Session start: stage, git baseline, baseline checks -----------------------
declare -A SES=()
read_values SES node "$RUN_HELPER" session-begin "$STATUS_PATH" "$RUN_NUMBER"
RUN_TYPE=${SES[type]:-BUILD}

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

echo "$TAG $TIMESTAMP - starting $PROJECT session #$RUN_NUMBER (${RUN_TYPE}, ${SES[stage]:-unknown} stage)${SES[note]:+ - ${SES[note]}}"

node "$RUN_HELPER" recent-runs "$LOG_FILE" "$RECENT_FILE"

cd "$PROJECT_DIR"

FULL_PROMPT=$(node "$RUN_HELPER" session-prompt "$STATUS_PATH" "$RUN_NUMBER" "$TODAY") || {
  echo "$TAG could not build the session prompt" >&2
  exit 1
}

# --- Agent invocation --------------------------------------------------------
if [ "$AGENT" = "claude" ]; then
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
# memory and the lab's run lock.
AGENT_EXIT=0
OUTPUT=$(timeout -k 60 "$AGENT_TIMEOUT" "$AGENT_BIN" "${AGENT_ARGS[@]}" 2>&1) || AGENT_EXIT=$?

FAILURE_MARK=""
if [ "$AGENT_EXIT" -eq 124 ] || [ "$AGENT_EXIT" -eq 137 ]; then
  FAILURE_MARK="[run failed - $AGENT killed after ${AGENT_TIMEOUT}s timeout]"
elif [ "$AGENT_EXIT" -ne 0 ]; then
  FAILURE_MARK="[run failed - $AGENT exited $AGENT_EXIT]"
fi
if [ -n "$FAILURE_MARK" ]; then
  # The agent's own last words, before the marker is prepended (a one-line
  # error such as a rate limit would otherwise repeat the marker).
  FAILURE_DETAIL=$(printf '%s\n' "$OUTPUT" | sed '/^[[:space:]]*$/d' | tail -n 3 | tr '\n' ' ' | cut -c1-260)
  OUTPUT="$FAILURE_MARK

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
if [ -n "$FAILURE_MARK" ]; then
  {
    echo ""
    echo "## Run $RUN_NUMBER - $TODAY - FAILED"
    echo ""
    echo "**Failure:** $FAILURE_MARK ${FAILURE_DETAIL:-no output before exit}"
    echo "**Output:** Full stdout saved to $STDOUT_FILE"
  } >> "$LOG_FILE"
elif ! grep -qE "^## Run $RUN_NUMBER[[:space:]]+[—-]" "$LOG_FILE"; then
  OUTPUT_EXCERPT=$(printf '%s\n' "$OUTPUT" | sed '/^[[:space:]]*$/d' | head -n 6 | tr '\n' ' ' | cut -c1-420)
  {
    echo ""
    echo "## Run $RUN_NUMBER - $TODAY - ${RUN_TYPE}"
    echo ""
    echo "**Done:** $AGENT_LABEL completed but did not append a run summary."
    echo "**Output excerpt:** ${OUTPUT_EXCERPT:-no stdout captured}"
    echo "**Output:** Full stdout saved to $STDOUT_FILE"
  } >> "$LOG_FILE"
fi

# --- Session end: lab checks, then keep (commit) or revert ---------------------
declare -A END=()
read_values END node "$RUN_HELPER" session-end "$STATUS_PATH" "$RUN_NUMBER" "$TODAY" "$AGENT_EXIT" "$AGENT" "$CLAUDE_MODEL" "$STDOUT_FILE" || true
echo "$TAG session #$RUN_NUMBER ${END[outcome]:-unrecorded}${END[reason]:+ - ${END[reason]}}"

# --- Independent review: a fresh, read-only agent judges the product ----------
if [ "${END[review]:-0}" = "1" ]; then
  REVIEWER=${END[reviewer]:-$REVIEWER}
  REVIEW_TIMEOUT=${REVIEW_TIMEOUT:-900}
  REVIEW_LOG="$STDOUT_DIR/review-run-$RUN_NUMBER.log"
  REVIEW_PROMPT=$(node "$RUN_HELPER" review-prompt "$STATUS_PATH" "$RUN_NUMBER" || true)
  REVIEW_OUTPUT=""
  REVIEW_EXIT=0
  if [ "$REVIEWER" = "claude" ] && REVIEW_BIN=$(resolve_claude_bin); then
    REVIEW_ARGS=(-p "$REVIEW_PROMPT" --permission-mode default --allowedTools "Read,Glob,Grep")
    if [ -n "$CLAUDE_MODEL" ]; then
      REVIEW_ARGS+=(--model "$CLAUDE_MODEL")
      [ "$CLAUDE_MODEL" != "sonnet" ] && REVIEW_ARGS+=(--fallback-model sonnet)
    fi
    REVIEW_OUTPUT=$(timeout -k 30 "$REVIEW_TIMEOUT" "$REVIEW_BIN" "${REVIEW_ARGS[@]}" 2>>"$REVIEW_LOG") || REVIEW_EXIT=$?
  elif [ "$REVIEWER" = "codex" ] && REVIEW_BIN=$(resolve_codex_bin); then
    REVIEW_ARGS=(exec -C "$PROJECT_DIR" --color never --sandbox read-only)
    [ -n "$CODEX_MODEL" ] && REVIEW_ARGS+=(--model "$CODEX_MODEL")
    REVIEW_OUTPUT=$(timeout -k 30 "$REVIEW_TIMEOUT" "$REVIEW_BIN" "${REVIEW_ARGS[@]}" "$REVIEW_PROMPT" 2>>"$REVIEW_LOG") || REVIEW_EXIT=$?
  else
    REVIEW_EXIT=127
    echo "$TAG reviewer $REVIEWER is not available" >> "$REVIEW_LOG"
  fi
  printf '%s\n' "$REVIEW_OUTPUT" >> "$REVIEW_LOG"
  printf '%s' "$REVIEW_OUTPUT" | node "$RUN_HELPER" review-apply "$STATUS_PATH" "$RUN_NUMBER" "$REVIEW_EXIT" "$REVIEWER" || true
fi

node "$RUN_HELPER" recent-runs "$LOG_FILE" "$RECENT_FILE"

echo "$TAG done"
