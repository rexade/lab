#!/bin/bash
# save-run.sh - extract the latest matching run record from RUN_LOG.md into memory/runs/.
# MemPalace is a derived index: this script writes canonical notes first, then mines them.
# Usage: ./save-run.sh [run_number]

set -euo pipefail

LAB_DIR=${LAB_DIR:-/home/admin/lab}
PALACE=${PALACE:-/home/admin/.local/bin/mempalace}
RUN_LOG_PATH="$LAB_DIR/RUN_LOG.md"
RUNS_DIR="$LAB_DIR/memory/runs"
HEALTH_PATH="$LAB_DIR/memory/index-health.json"
MINE_TIMEOUT_SECONDS=${SAVE_RUN_MINE_TIMEOUT_SECONDS:-240}
mkdir -p "$RUNS_DIR" "$(dirname "$HEALTH_PATH")"

RUN_NUM=${1:-}
if [ -z "$RUN_NUM" ]; then
  RUN_NUM=$(python3 - "$RUN_LOG_PATH" <<'PYEOF'
import re, sys
try:
    text = open(sys.argv[1], encoding='utf-8').read()
except FileNotFoundError:
    print('0')
    raise SystemExit
nums = [int(m.group(1)) for m in re.finditer(r'^## Run (\d+)\b', text, re.MULTILINE)]
print(max(nums) if nums else 0)
PYEOF
)
fi

python3 - "$RUN_LOG_PATH" "$RUN_NUM" "$RUNS_DIR" "$HEALTH_PATH" <<'PYEOF'
import datetime as dt
import json
import os
import re
import sys
import tempfile

log_path, run_num_s, runs_dir, health_path = sys.argv[1:5]
try:
    n = int(run_num_s)
except ValueError:
    n = 0

now = dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z')

def latest_memory_run():
    latest = 0
    try:
        for name in os.listdir(runs_dir):
            m = re.match(r'run-(\d+)\.md$', name)
            if m:
                latest = max(latest, int(m.group(1)))
    except FileNotFoundError:
        pass
    return latest or None

def latest_log_run(text):
    nums = [int(m.group(1)) for m in re.finditer(r'^## Run (\d+)\b', text, re.MULTILINE)]
    return max(nums) if nums else None

def write_health(text='', status='extract_failed', saved_run=None, error=''):
    latest_log = latest_log_run(text) if text else None
    latest_mem = latest_memory_run()
    lag = None
    if latest_log is not None and latest_mem is not None:
        lag = max(0, latest_log - latest_mem)
    payload = {
        'status': status,
        'latestRunLogRun': latest_log,
        'latestMemoryRun': latest_mem,
        'lastIndexedRun': latest_mem,
        'lastAttemptedRun': n or None,
        'lastSavedRun': saved_run,
        'lastMineExitCode': None,
        'memoryLag': lag,
        'indexedAt': None,
        'updatedAt': now,
        'source': 'save-run.sh',
        'lastError': error,
    }
    os.makedirs(os.path.dirname(health_path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.index-health.', suffix='.json', dir=os.path.dirname(health_path))
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2)
        f.write('\n')
    os.replace(tmp, health_path)

if n <= 0:
    write_health(status='no_run_number', error=f'invalid run number: {run_num_s!r}')
    print(f'[save-run] invalid run number: {run_num_s}', file=sys.stderr)
    raise SystemExit(2)

try:
    text = open(log_path, encoding='utf-8').read()
except FileNotFoundError:
    write_health(status='missing_run_log', error=f'missing {log_path}')
    print(f'[save-run] missing {log_path}', file=sys.stderr)
    raise SystemExit(2)

formal_pattern = re.compile(rf'^(## Run {n}\b[\s\S]*?)(?=^## Run \d+\b|\Z)', re.MULTILINE)
formal_matches = list(formal_pattern.finditer(text))
if formal_matches:
    block = formal_matches[-1].group(1).strip()
    block = re.split(r'\n?<!--\s*stdout from run \d+\b[^>]*-->', block, maxsplit=1)[0].strip()
    source = 'formal'
else:
    stdout_pattern = re.compile(rf'<!--\s*stdout from run {n}\b[^>]*-->\s*([\s\S]*?)(?=<!--\s*stdout from run \d+\b|^## Run \d+\b|\Z)', re.MULTILINE)
    stdout_matches = list(stdout_pattern.finditer(text))
    if not stdout_matches:
        write_health(text, status='no_entry', error=f'no formal or stdout entry found for run {n}')
        print(f'[save-run] no entry found for run {n}', file=sys.stderr)
        raise SystemExit(2)
    body = stdout_matches[-1].group(1).strip()
    block = f'## Run {n} - stdout capture\n\n{body[:4000]}'
    source = 'stdout'

out_path = os.path.join(runs_dir, f'run-{n:03d}.md')
content = f'# Run {n:03d}\n\n_Source: {source}; extracted by save-run.sh_\n\n{block}\n'
fd, tmp = tempfile.mkstemp(prefix=f'.run-{n:03d}.', suffix='.md', dir=runs_dir)
with os.fdopen(fd, 'w', encoding='utf-8') as f:
    f.write(content)
os.replace(tmp, out_path)
write_health(text, status='saved_pending_mine', saved_run=n)
print(f'[save-run] wrote {out_path} ({source})')
PYEOF

MEMPALACE_VERSION="unavailable"
if [ -x "$PALACE" ]; then
  set +e
  VERSION_RAW=$("$PALACE" --version 2>&1)
  VERSION_EXIT=$?
  set -e
  VERSION_RAW=${VERSION_RAW//$'\n'/ }
  if [ "$VERSION_EXIT" -eq 0 ]; then
    MEMPALACE_VERSION=${VERSION_RAW:-unknown}
  else
    MEMPALACE_VERSION="unavailable: ${VERSION_RAW:0:180}"
  fi
else
  MEMPALACE_VERSION="missing executable at $PALACE"
fi

if [ "${SAVE_RUN_SKIP_MINE:-0}" = "1" ]; then
  MINE_EXIT=""
  MINE_OUTPUT="mining skipped by SAVE_RUN_SKIP_MINE=1"
  INDEXED_AT=""
  HEALTH_STATUS="saved_skip_mine"
else
  if [ ! -x "$PALACE" ]; then
    MINE_EXIT=127
    MINE_OUTPUT="mempalace executable not found at $PALACE"
  else
    set +e
    MINE_OUTPUT=$(timeout "$MINE_TIMEOUT_SECONDS" "$PALACE" mine "$LAB_DIR/memory/" 2>&1)
    MINE_EXIT=$?
    set -e
    if [ "$MINE_EXIT" -eq 124 ]; then
      MINE_OUTPUT=$(printf 'mempalace mine timed out after %ss\n%s' "$MINE_TIMEOUT_SECONDS" "$MINE_OUTPUT")
    fi
  fi
  INDEXED_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  if [ "$MINE_EXIT" -eq 0 ]; then
    HEALTH_STATUS="healthy"
  else
    HEALTH_STATUS="mine_failed"
  fi
fi

MINE_EXIT="$MINE_EXIT" \
MINE_OUTPUT="$MINE_OUTPUT" \
MEMPALACE_VERSION="$MEMPALACE_VERSION" \
INDEXED_AT="$INDEXED_AT" \
HEALTH_STATUS="$HEALTH_STATUS" \
RUN_NUM="$RUN_NUM" \
python3 - "$RUN_LOG_PATH" "$RUNS_DIR" "$HEALTH_PATH" <<'PYEOF'
import datetime as dt
import json
import os
import re
import sys
import tempfile

log_path, runs_dir, health_path = sys.argv[1:4]
now = dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z')
try:
    text = open(log_path, encoding='utf-8').read()
except FileNotFoundError:
    text = ''
nums = [int(m.group(1)) for m in re.finditer(r'^## Run (\d+)\b', text, re.MULTILINE)]
latest_log = max(nums) if nums else None
latest_mem = None
try:
    for name in os.listdir(runs_dir):
        m = re.match(r'run-(\d+)\.md$', name)
        if m:
            latest_mem = max(latest_mem or 0, int(m.group(1)))
except FileNotFoundError:
    pass
lag = None
if latest_log is not None and latest_mem is not None:
    lag = max(0, latest_log - latest_mem)
exit_raw = os.environ.get('MINE_EXIT', '')
try:
    mine_exit = int(exit_raw) if exit_raw != '' else None
except ValueError:
    mine_exit = None
status = os.environ.get('HEALTH_STATUS') or ('healthy' if mine_exit == 0 else 'mine_failed')
last_error = '' if mine_exit in (None, 0) else os.environ.get('MINE_OUTPUT', '')[:500]
payload = {
    'status': status,
    'latestRunLogRun': latest_log,
    'latestMemoryRun': latest_mem,
    'lastIndexedRun': latest_mem if mine_exit == 0 else None,
    'lastAttemptedRun': int(os.environ.get('RUN_NUM') or 0) or None,
    'lastSavedRun': int(os.environ.get('RUN_NUM') or 0) or None,
    'lastMineExitCode': mine_exit,
    'memoryLag': lag,
    'indexedAt': os.environ.get('INDEXED_AT') or None,
    'updatedAt': now,
    'mempalaceVersion': os.environ.get('MEMPALACE_VERSION') or 'unknown',
    'source': 'save-run.sh',
    'lastMineOutput': os.environ.get('MINE_OUTPUT', '')[:500],
    'lastError': last_error,
}
os.makedirs(os.path.dirname(health_path), exist_ok=True)
fd, tmp = tempfile.mkstemp(prefix='.index-health.', suffix='.json', dir=os.path.dirname(health_path))
with os.fdopen(fd, 'w', encoding='utf-8') as f:
    json.dump(payload, f, indent=2)
    f.write('\n')
os.replace(tmp, health_path)
PYEOF

if [ "${SAVE_RUN_SKIP_MINE:-0}" = "1" ]; then
  echo "[save-run] memory note saved; mining skipped"
elif [ "$MINE_EXIT" -eq 0 ]; then
  echo "[save-run] mined memory/ into palace"
else
  echo "[save-run] warning: mempalace mine failed with exit $MINE_EXIT" >&2
  exit "$MINE_EXIT"
fi
