#!/usr/bin/env bash
# Stable Codex entrypoint (referenced by status.json files, launchers, and the
# core lab). The implementation is src/pi-pulse/scripts/run-incubator.sh.
# Usage: run-codex-incubator.sh <status.json> [create|mutate|research|harvest]
set -euo pipefail
REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
export PI_PULSE_AGENT=codex
exec bash "$REPO_DIR/src/pi-pulse/scripts/run-incubator.sh" "$@"
