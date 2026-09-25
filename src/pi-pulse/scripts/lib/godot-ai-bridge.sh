#!/usr/bin/env bash
# Godot AI MCP bridge for incubators whose status.json sets godotAi.enabled.
# Sourced by run-incubator.sh; expects PROJECT_DIR and the GODOT_AI_* variables.
# Paths match the Pi install; override with GODOT_BIN / UVX_BIN / GODOT_AI_SERVER_PID_FILE.

GODOT_BIN=${GODOT_BIN:-/home/admin/godot/Godot_v4.6.1-stable_linux.arm64}
UVX_BIN=${UVX_BIN:-/home/admin/.local/bin/uvx}
GODOT_AI_SERVER_PID_FILE=${GODOT_AI_SERVER_PID_FILE:-"/home/admin/.local/share/godot/app_userdata/Tidebound Harbor Godot/godot_ai_server.pid"}

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
  mkdir -p "$(dirname "$GODOT_AI_LOG")"
  setsid env \
    GODOT_AI_ALLOW_HEADLESS=1 \
    GODOT_AI_DISABLE_TELEMETRY=true \
    DISABLE_TELEMETRY=true \
    PATH="$(dirname "$UVX_BIN"):$PATH" \
    "$GODOT_BIN" --headless --editor --path "$PROJECT_DIR" \
    > "$GODOT_AI_LOG" 2>&1 < /dev/null &
}

ensure_godot_ai_bridge() {
  if [ -z "$GODOT_AI_ENABLED" ]; then
    return 0
  fi

  local editor_pattern="$GODOT_BIN --headless --editor --path $PROJECT_DIR"

  if [ ! -x "$GODOT_BIN" ] || [ ! -x "$UVX_BIN" ]; then
    echo "[incubator] godot-ai bridge skipped: missing godot or uvx" >&2
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

  echo "[incubator] godot-ai bridge stale; restarting editor/server" >&2
  pkill -TERM -f "$editor_pattern" >/dev/null 2>/dev/null || true
  if [ -f "$GODOT_AI_SERVER_PID_FILE" ]; then
    kill -TERM "$(cat "$GODOT_AI_SERVER_PID_FILE")" >/dev/null 2>/dev/null || true
  fi
  sleep 2
  start_godot_ai_editor

  for _ in $(seq 1 30); do
    if godot_ai_mcp_ready; then
      return 0
    fi
    sleep 1
  done

  echo "[incubator] godot-ai bridge did not become MCP-ready at $GODOT_AI_MCP_URL" >&2
}
