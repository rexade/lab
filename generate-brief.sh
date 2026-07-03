#!/bin/bash
# generate-brief.sh — build MEMORY_BRIEF.md before a lab run
# Uses mempalace wake-up (L0+L1 ~170 tokens) + live seed/threads.
# Usage: ./generate-brief.sh [run_type]

set -euo pipefail

LAB_DIR=/home/admin/lab
PALACE=/home/admin/.local/bin/mempalace
RUN_TYPE=${1:-mutate}
RUN_COUNT=$(grep -c "^## Run " "$LAB_DIR/RUN_LOG.md" 2>/dev/null || echo 0)
NEXT_RUN=$((RUN_COUNT + 1))

# L0+L1 from palace wake-up — structured identity + critical facts (~170 tokens)
WAKEUP=$($PALACE wake-up --wing lab 2>/dev/null | \
  python3 -c "
import sys, re
text = sys.stdin.read()
text = re.sub(r'\x1b\[[0-9;]*[mGKH]', '', text)
text = re.sub(r'^Wake-up text.*\n', '', text, flags=re.MULTILINE)
text = re.sub(r'^={10,}\n', '', text, flags=re.MULTILINE)
print(text.strip()[:1200])
" 2>/dev/null)

# Seed direction — live read of DAILY_SEED.md (~150 chars)
DIRECTION=$(python3 -c "
import re
try:
    text = open('$LAB_DIR/DAILY_SEED.md').read()
    m = re.search(r'\*\*Direction:\*\*\s*\n(.+?)(\n\n|\n##|\Z)', text, re.DOTALL)
    if m: print(m.group(1).strip()[:200])
    else: print(text.strip()[:200])
except: pass" 2>/dev/null)

# Active thread — live read (rewritten each run, always current)
ACTIVE=$(python3 -c "
try:
    lines = open('$LAB_DIR/ACTIVE_THREADS.md').read().strip().split('\n')
    bullets = [l.strip() for l in lines if l.strip().startswith('-')][:3]
    print('\n'.join(bullets)[:250])
except: pass" 2>/dev/null)

cat > "$LAB_DIR/MEMORY_BRIEF.md" << BRIEF
# Memory Brief — ${RUN_TYPE^^} #${NEXT_RUN}
*$(date '+%Y-%m-%d %H:%M') — pre-run context*

## Palace context (L0+L1)
${WAKEUP:-"(palace unavailable — read TASTE_PROFILE.md and DAILY_SEED.md)"}

## Seed direction
${DIRECTION:-"(read DAILY_SEED.md)"}

## Active thread
${ACTIVE:-"(check ACTIVE_THREADS.md)"}
BRIEF

echo "[brief] MEMORY_BRIEF.md → $(wc -c < "$LAB_DIR/MEMORY_BRIEF.md") bytes"
