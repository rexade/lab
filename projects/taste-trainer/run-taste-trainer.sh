#!/usr/bin/env bash
set -euo pipefail

STATUS_PATH="${1:-/home/admin/lab/projects/taste-trainer/status.json}"
RUN_TYPE="${2:-}"
RUNNER=$(node -e "const fs=require('fs'); const o=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(o.runner || 'codex')" "$STATUS_PATH")

if [ "$RUNNER" = "claude" ]; then
  exec /home/admin/lab/src/pi-pulse/scripts/run-claude-incubator.sh "$STATUS_PATH" "$RUN_TYPE"
fi

exec /home/admin/lab/scripts/run-codex-incubator.sh "$STATUS_PATH" "$RUN_TYPE"
