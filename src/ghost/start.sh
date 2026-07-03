#!/bin/bash
# ghost-trio start.sh — brings up all four instruments + ensemble
# Runs as a supervisor: watches each process, restarts if crashed.
# Used by ghost-trio.service (systemd).
#
# Ports:
#   ghost       :3032  — threshold events
#   whisper     :3033  — statistical novelty
#   oracle      :3034  — episodic sessions
#   convergence :3036  — multi-instrument detector + haiku
#   ensemble    :3035  — unified view
#   daily       :3037  — daily machine diary

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="/tmp/ghost-trio"
mkdir -p "$LOG_DIR"

declare -A PIDS
INSTRUMENTS=(ghost whisper oracle convergence ensemble daily)

cleanup() {
  echo "[ghost-trio] shutting down..."
  for name in "${INSTRUMENTS[@]}"; do
    if [[ -n "${PIDS[$name]+x}" ]] && kill -0 "${PIDS[$name]}" 2>/dev/null; then
      kill "${PIDS[$name]}" 2>/dev/null || true
      echo "[ghost-trio] stopped $name (${PIDS[$name]})"
    fi
  done
  exit 0
}
trap cleanup SIGTERM SIGINT SIGQUIT

start_instrument() {
  local name="$1"
  local script="$2"
  local log="$LOG_DIR/$name.log"
  node "$DIR/$script" >> "$log" 2>&1 &
  PIDS[$name]=$!
  echo "[ghost-trio] started $name (PID ${PIDS[$name]}) → $log"
}

echo "[ghost-trio] starting quartet — $(date)"
start_instrument "ghost"       "ghost.js"
sleep 0.3
start_instrument "whisper"     "whisper.js"
sleep 0.3
start_instrument "oracle"      "oracle.js"
sleep 0.3
start_instrument "convergence" "convergence.js"
sleep 0.3
start_instrument "ensemble"    "ensemble.js"
sleep 0.3
start_instrument "daily"       "daily.js"

echo "[ghost-trio] all instruments online"
echo "[ghost-trio] ensemble view → http://localhost:3035"
echo "[ghost-trio] daily diary   → http://localhost:3037"

# Supervisor loop — check every 10s, restart crashed instruments
while true; do
  sleep 10
  for name in "${INSTRUMENTS[@]}"; do
    if ! kill -0 "${PIDS[$name]}" 2>/dev/null; then
      echo "[ghost-trio] $name crashed (was PID ${PIDS[$name]}) — restarting"
      case "$name" in
        ghost)       start_instrument "ghost"       "ghost.js" ;;
        whisper)     start_instrument "whisper"     "whisper.js" ;;
        oracle)      start_instrument "oracle"      "oracle.js" ;;
        convergence) start_instrument "convergence" "convergence.js" ;;
        ensemble)    start_instrument "ensemble"    "ensemble.js" ;;
        daily)       start_instrument "daily"       "daily.js" ;;
      esac
    fi
  done
done
