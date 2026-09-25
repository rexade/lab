#!/usr/bin/env bash
# Stable Claude entrypoint (referenced as claudeRunScript in status.json files).
# The implementation is run-incubator.sh next to this file.
# Usage: run-claude-incubator.sh <status.json> [create|mutate|research|harvest]
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export PI_PULSE_AGENT=claude
exec bash "$SCRIPT_DIR/run-incubator.sh" "$@"
