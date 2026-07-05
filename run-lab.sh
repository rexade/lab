#!/bin/bash
# run-lab.sh — seed -> drift -> report loop
# Runs Claude Code headless in feral lab mode.
# Triggered by systemd timer or manually.

set -euo pipefail

# Use OAuth (claude.ai subscription) — never API key
unset CLAUDECODE 2>/dev/null || true
unset ANTHROPIC_API_KEY 2>/dev/null || true
unset ANTHROPIC_AUTH_TOKEN 2>/dev/null || true

export HOME=/home/admin
export USER=admin
export LOGNAME=admin
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/1000}
export XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-/home/admin/.config}
export XDG_CACHE_HOME=${XDG_CACHE_HOME:-/home/admin/.cache}
export XDG_DATA_HOME=${XDG_DATA_HOME:-/home/admin/.local/share}
export PATH="/home/admin/.npm-global/bin:/home/admin/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"

LAB_DIR=/home/admin/lab
LOG_FILE=$LAB_DIR/RUN_LOG.md
RECENT_FILE=$LAB_DIR/RECENT_RUNS.md
FEEDBACK_FILE=${FEEDBACK_FILE:-$LAB_DIR/USER_FEEDBACK.md}
SEED_FILE=$LAB_DIR/DAILY_SEED.md
MEMPALACE=/home/admin/.local/bin/mempalace
TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
CLAUDE_MODEL=${CLAUDE_MODEL:-fable}

# Rotation: create -> mutate -> research -> mutate -> repeat
# Harvest is manual only: ./run-lab.sh harvest
RUN_TYPES=("create" "mutate" "research" "mutate")
# Derive from max existing run number, not header count.
# Handles duplicates (runs 6/9/59 have appeared twice) and gaps (12/24/33 missing)
# without collision on the next number.
LAST_RUN=$(grep -oE "^## Run [0-9]+" "$LOG_FILE" 2>/dev/null | grep -oE "[0-9]+" | sort -n | tail -1 || true)
RUN_COUNT=${LAST_RUN:-0}

if [[ "${1:-}" =~ ^(create|mutate|research|harvest)$ ]]; then
    RUN_TYPE="$1"
else
    RUN_TYPE="${RUN_TYPES[$((RUN_COUNT % ${#RUN_TYPES[@]}))]}"
fi

PROMPT_FILE=$LAB_DIR/prompts/$RUN_TYPE.md

echo "[run-lab] $TIMESTAMP — starting $RUN_TYPE run (#$((RUN_COUNT + 1)))"

# Generate lean MEMORY_BRIEF.md from MemPalace before loading the prompt
bash "$LAB_DIR/generate-brief.sh" "$RUN_TYPE" || echo "[run-lab] brief generation failed (non-fatal)"

# Regenerate RECENT_RUNS.md from the last 4 entries in RUN_LOG.md
# Handles both ## Run N headings and <!-- stdout from run N --> blocks
python3 - "$LOG_FILE" "$RECENT_FILE" << 'PYEOF'
import sys, re

log_path, recent_path = sys.argv[1], sys.argv[2]

try:
    text = open(log_path).read()
except FileNotFoundError:
    text = ""

by_num = {}

# Format 1: formal ## Run N — DATE — TYPE sections
for m in re.finditer(r'^(## Run (\d+) — .+?)(?=^## Run \d|\Z)', text, re.MULTILINE | re.DOTALL):
    num = int(m.group(2))
    # Trim at first stdout comment so we don't bloat with old stdout
    block = re.split(r'<!--\s*stdout from run', m.group(1))[0].strip()
    by_num[num] = block

# Format 2: <!-- stdout from run N DATE --> blocks
for m in re.finditer(r'<!--\s*stdout from run (\d+)\s+(\d{4}-\d{2}-\d{2})[^>]*-->([\s\S]*?)(?=<!--\s*stdout from run \d|\Z)', text):
    slot, date, body = int(m.group(1)), m.group(2), m.group(3).strip()
    if not body or '[run failed' in body:
        continue
    # Bold **Run N — TYPE** inside body names the actual run
    bm = re.search(r'\*\*Run (\d+)\s*(?:—\s*([\w ]+?)\s*—|—\s*done)', body)
    num = int(bm.group(1)) if bm else slot + 1
    raw_type = (bm.group(2) or '').strip().upper() if bm else ''
    run_type = next((t for t in ['MUTATE','RESEARCH','CREATE'] if t in raw_type), raw_type or 'RUN')
    if num not in by_num:
        # Trim body to first 60 lines to keep RECENT_RUNS concise
        trimmed = '\n'.join(body.splitlines()[:60])
        by_num[num] = f"## Run {num} — {date} — {run_type}\n\n{trimmed}"

runs = [by_num[k] for k in sorted(by_num)]
recent = runs[-4:] if len(runs) >= 4 else runs

with open(recent_path, 'w') as f:
    f.write("# Recent Runs\n\n")
    f.write("*Auto-generated. Last 4 runs. Full history in RUN_LOG.md.*\n\n---\n\n")
    f.write("\n\n---\n\n".join(recent) if recent else "*(no runs yet)*\n")
PYEOF

# Run Claude Code headless in the lab directory
cd "$LAB_DIR"
STATUS_FILE=$LAB_DIR/projects/pi-pulse/status.json
FEEDBACK_UPDATED_AT=""
FEEDBACK_BLOCK=""
PENDING_FEEDBACK_TEXT=$(python3 -c "
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    updated = data.get('feedbackUpdatedAt') or ''
    consumed = data.get('feedbackConsumedAt') or ''
    text = (data.get('latestUserFeedback') or '').strip()
    if text and updated and updated > consumed:
        print(updated)
        print(text[:1200])
except Exception:
    pass" "$STATUS_FILE" 2>/dev/null)
if [ -n "$PENDING_FEEDBACK_TEXT" ]; then
    FEEDBACK_UPDATED_AT=$(printf '%s
' "$PENDING_FEEDBACK_TEXT" | head -n 1)
    LATEST_FEEDBACK_TEXT=$(printf '%s
' "$PENDING_FEEDBACK_TEXT" | tail -n +2)
    RECENT_FEEDBACK_TEXT=$(tail -n 120 "$FEEDBACK_FILE" 2>/dev/null || true)
    FEEDBACK_BLOCK=$(printf "PENDING USER STEERING - HIGHEST PRIORITY FOR THIS RUN:
%s

RECENT STEERING CONTEXT:
%s" "$LATEST_FEEDBACK_TEXT" "$RECENT_FEEDBACK_TEXT")
fi
BASE_PROMPT=$(cat "$PROMPT_FILE")
if [ -n "$FEEDBACK_BLOCK" ]; then
    FULL_PROMPT=$(printf "The following pending user steering overrides older backlog, memory, and inferred goals when they conflict. Make this run visibly address it. Runs without pending steering should follow the base prompt normally.

%s

--- BASE RUN PROMPT ---

%s" "$FEEDBACK_BLOCK" "$BASE_PROMPT")
else
    FULL_PROMPT="$BASE_PROMPT"
fi
BUILD_MARKER=$(mktemp)
CLAUDE_EXIT=0
OUTPUT=$(claude \
    --print \
    --allowedTools "Read Write Edit Bash(npm*) Bash(npx*) Bash(cd*) Bash(cat*) Bash(ls*)" \
    --add-dir "$LAB_DIR" \
    --model "$CLAUDE_MODEL" \
    --fallback-model sonnet \
    "$FULL_PROMPT" 2>&1) || CLAUDE_EXIT=$?

if [ "$CLAUDE_EXIT" -ne 0 ]; then
    OUTPUT="[run failed — claude exited $CLAUDE_EXIT]

$OUTPUT"
fi

echo "[run-lab] run complete, logging"

# Post-run build check — not a milestone gate, just "did it compile".
# Only fires when the run actually touched pi-pulse source; catches a run
# claiming success while leaving the UI broken (decisions.md: never deploy
# a failing build).
BUILD_NOTE=""
CHANGED=$(find "$LAB_DIR/src/pi-pulse/src" \
    "$LAB_DIR/src/pi-pulse/server.js" \
    "$LAB_DIR/src/pi-pulse/index.html" \
    "$LAB_DIR/src/pi-pulse/tailwind.config.js" \
    "$LAB_DIR/src/pi-pulse/postcss.config.js" \
    "$LAB_DIR/src/pi-pulse/vite.config.js" \
    -type f -newer "$BUILD_MARKER" -print -quit 2>/dev/null || true)
rm -f "$BUILD_MARKER"
if [ -n "$CHANGED" ]; then
    echo "[run-lab] pi-pulse source changed — verifying npm run build"
    if (cd "$LAB_DIR/src/pi-pulse" && npm run build > /dev/null 2>&1); then
        BUILD_NOTE="[build check] PASS — this run changed pi-pulse and npm run build succeeded"
    else
        BUILD_NOTE="[build check] FAIL — this run changed pi-pulse and npm run build FAILED; UI may be broken"
    fi
    echo "[run-lab] $BUILD_NOTE"
fi

# Claude should have written directly to RUN_LOG.md and ACTIVE_THREADS.md
# as instructed by the prompt. Append its stdout too as a fallback record.
{
    echo ""
    echo "<!-- stdout from run $((RUN_COUNT + 1)) $TIMESTAMP -->"
    echo "$OUTPUT"
    if [ -n "$BUILD_NOTE" ]; then
        echo ""
        echo "$BUILD_NOTE"
    fi
    echo ""
} >> "$LOG_FILE"

if [ -n "${FEEDBACK_UPDATED_AT:-}" ]; then
    python3 -c "
import json, sys
path, consumed_at, run_num = sys.argv[1:4]
try:
    data = json.load(open(path))
except Exception:
    data = {}
if data.get('feedbackUpdatedAt') == consumed_at:
    data['feedbackConsumedAt'] = consumed_at
    data['feedbackConsumedRun'] = int(run_num)
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')
" "$STATUS_FILE" "$FEEDBACK_UPDATED_AT" "$((RUN_COUNT + 1))" || echo "[run-lab] feedback consume marker failed (non-fatal)"
fi

# Save run summary to structured memory and mine just the memory dir
bash "$LAB_DIR/save-run.sh" "$((RUN_COUNT + 1))" || echo "[run-lab] save-run failed (non-fatal)"

echo "[run-lab] done"
