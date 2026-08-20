#!/bin/bash
# generate-brief.sh - build MEMORY_BRIEF.md before a lab run.
# Uses MemPalace as optional older-context retrieval, never as current state.
# Usage: ./generate-brief.sh [run_type]

set -euo pipefail

LAB_DIR=${LAB_DIR:-/home/admin/lab}
PALACE=${PALACE:-/home/admin/.local/bin/mempalace}
RUN_TYPE=${1:-mutate}
BRIEF_PATH="$LAB_DIR/MEMORY_BRIEF.md"
HEALTH_PATH="$LAB_DIR/memory/index-health.json"
LAST_RUN=$(grep -oE "^## Run [0-9]+" "$LAB_DIR/RUN_LOG.md" 2>/dev/null | grep -oE "[0-9]+" | sort -n | tail -1 || true)
RUN_COUNT=${LAST_RUN:-0}
NEXT_RUN=$((RUN_COUNT + 1))

WAKEUP_STATUS="ok"
WAKEUP_ERROR=""
WAKEUP_RAW=""
WAKEUP_EXIT=0
if [ ! -x "$PALACE" ]; then
  WAKEUP_STATUS="unavailable"
  WAKEUP_ERROR="mempalace executable not found at $PALACE"
else
  set +e
  WAKEUP_RAW=$("$PALACE" wake-up --wing lab 2>&1)
  WAKEUP_EXIT=$?
  set -e
  if [ "$WAKEUP_EXIT" -ne 0 ]; then
    WAKEUP_STATUS="unavailable"
    WAKEUP_ERROR="mempalace wake-up exited $WAKEUP_EXIT: $(printf '%s' "$WAKEUP_RAW" | tr '\n' ' ' | cut -c1-220)"
  fi
fi

if [ "$WAKEUP_STATUS" = "ok" ]; then
  WAKEUP=$(printf '%s\n' "$WAKEUP_RAW" | python3 -c "
import sys, re
text = sys.stdin.read()
text = re.sub(r'\x1b\[[0-9;]*[mGKH]', '', text)
text = re.sub(r'^Wake-up text.*\n', '', text, flags=re.MULTILINE)
text = re.sub(r'^={10,}\n', '', text, flags=re.MULTILINE)
print(text.strip()[:1200])
" 2>/dev/null || true)
else
  WAKEUP="(memory unavailable - ${WAKEUP_ERROR})"
fi

DIRECTION=$(python3 - "$LAB_DIR/DAILY_SEED.md" <<'PYEOF'
import re, sys
try:
    text = open(sys.argv[1]).read()
    m = re.search(r'\*\*Direction:\*\*\s*\n(.+?)(\n\n|\n##|\Z)', text, re.DOTALL)
    print((m.group(1).strip() if m else text.strip())[:200])
except Exception:
    pass
PYEOF
)

ACTIVE=$(python3 - "$LAB_DIR/ACTIVE_THREADS.md" <<'PYEOF'
import sys
try:
    lines = open(sys.argv[1]).read().strip().split('\n')
    bullets = [line.strip() for line in lines if line.strip().startswith('-')][:3]
    print('\n'.join(bullets)[:250])
except Exception:
    pass
PYEOF
)

PENDING_FEEDBACK=$(python3 - "$LAB_DIR/projects/pi-pulse/status.json" <<'PYEOF'
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    updated = data.get('feedbackUpdatedAt') or ''
    consumed = data.get('feedbackConsumedAt') or ''
    text = (data.get('latestUserFeedback') or '').strip()
    if text and updated and updated > consumed:
        print(text[:650])
except Exception:
    pass
PYEOF
)

MEMORY_HEALTH=$(python3 - "$HEALTH_PATH" <<'PYEOF'
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    latest = data.get('latestRunLogRun')
    indexed = data.get('lastIndexedRun')
    lag = data.get('memoryLag')
    status = data.get('status') or 'unknown'
    detail = data.get('lastError') or data.get('lastMineOutput') or ''
    print(f"status={status}; latest_run={latest}; indexed_run={indexed}; lag={lag}; {str(detail)[:180]}")
except Exception:
    print('status=unknown; no memory/index-health.json yet')
PYEOF
)

TMP=$(mktemp "$BRIEF_PATH.tmp.XXXXXX")
trap 'rm -f "$TMP"' EXIT
cat > "$TMP" << BRIEF
# Memory Brief - ${RUN_TYPE^^} #${NEXT_RUN}
*$(date '+%Y-%m-%d %H:%M') - pre-run context*

## Current-state authority
- Current run number comes from RUN_LOG.md/status.json, not MemPalace retrieval.
- MemPalace is optional historical context. If memory health is stale or unavailable, trust status files, seed files, recent runs, and tests first.
- Memory health: ${MEMORY_HEALTH}

## Pending user steering
${PENDING_FEEDBACK:-"(none pending)"}

## Palace context (older related memory)
${WAKEUP:-"(palace returned no wake-up text - read TASTE_PROFILE.md and DAILY_SEED.md)"}

## Seed direction
${DIRECTION:-"(read DAILY_SEED.md)"}

## Active thread
${ACTIVE:-"(check ACTIVE_THREADS.md)"}
BRIEF
mv "$TMP" "$BRIEF_PATH"
trap - EXIT

if [ "$WAKEUP_STATUS" != "ok" ]; then
  echo "[brief] warning: $WAKEUP_ERROR" >&2
fi
echo "[brief] MEMORY_BRIEF.md -> $(wc -c < "$BRIEF_PATH") bytes"
