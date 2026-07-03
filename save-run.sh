#!/bin/bash
# save-run.sh — extract latest run summary from RUN_LOG.md → memory/runs/
# Called after each lab run. Writes structured note, then mines memory/ into palace.
# Usage: ./save-run.sh [run_number]

set -euo pipefail

LAB_DIR=/home/admin/lab
PALACE=/home/admin/.local/bin/mempalace
RUNS_DIR="$LAB_DIR/memory/runs"
mkdir -p "$RUNS_DIR"

RUN_NUM="${1:-$(grep -oE "^## Run [0-9]+" "$LAB_DIR/RUN_LOG.md" 2>/dev/null | grep -oE "[0-9]+" | sort -n | tail -1)}"
RUN_NUM=${RUN_NUM:-0}

python3 - "$LAB_DIR/RUN_LOG.md" "$RUN_NUM" "$RUNS_DIR" << 'PYEOF'
import sys, re, os

log_path, run_num_s, runs_dir = sys.argv[1], sys.argv[2], sys.argv[3]
n = int(run_num_s)

try:
    text = open(log_path).read()
except FileNotFoundError:
    sys.exit(0)

# Try formal ## Run N section first
m = re.search(rf'^(## Run {n}\b.+?)(?=^## Run \d|\Z)', text, re.MULTILINE | re.DOTALL)
if m:
    block = m.group(1).strip()
    # Trim at stdout comment block to keep it lean
    block = re.split(r'<!--\s*stdout from run', block)[0].strip()
else:
    # Fall back to last stdout block
    stdout_blocks = list(re.finditer(
        r'<!--\s*stdout from run \d+[^>]*-->([\s\S]*?)(?=<!--\s*stdout from run|\Z)', text
    ))
    if not stdout_blocks:
        print(f'[save-run] no entry found for run {n}')
        sys.exit(0)
    body = stdout_blocks[-1].group(1).strip()
    block = f"## Run {n} — stdout\n\n{body[:600]}"

out_path = os.path.join(runs_dir, f'run-{n:03d}.md')
with open(out_path, 'w') as f:
    f.write(f"# Run {n:03d}\n\n{block}\n")
print(f'[save-run] wrote {out_path}')
PYEOF

# Mine only the structured memory directory — fast, no source code noise
echo "" | $PALACE mine "$LAB_DIR/memory/" 2>/dev/null || true
echo "[save-run] mined memory/ into palace"
