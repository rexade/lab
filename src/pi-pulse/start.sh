#!/bin/bash
# Pi Pulse supervisor — restarts server.js whenever dist/ changes (exit 0)
PORT=8089

wait_port_free() {
  for i in $(seq 1 20); do
    ss -tlnp | grep -q ":${PORT} " || return 0
    sleep 0.5
  done
  echo "[pi-pulse] port ${PORT} still busy after 10s — forcing kill"
  fuser -k ${PORT}/tcp 2>/dev/null
  sleep 1
}

echo "[pi-pulse] starting supervisor"
while true; do
  node server.js
  echo "[pi-pulse] restarting in 1s..."
  pkill -TERM -f "node server.js" 2>/dev/null
  sleep 1
  wait_port_free
done
