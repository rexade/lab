#!/usr/bin/env bash
# Freeform workshop entrypoint; both agents share controller-owned verification.
set -euo pipefail
export LAB_DIR=${LAB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}
export PI_PULSE_CORE_RUN=1
export PI_PULSE_AGENT=${PI_PULSE_AGENT:-claude}
export PI_PULSE_RUN_TYPE=${1:-}
unset CLAUDECODE ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN 2>/dev/null || true
exec bash "$LAB_DIR/src/pi-pulse/scripts/run-incubator.sh" "${PI_PULSE_CORE_STATUS_PATH:-$LAB_DIR/projects/pi-pulse/status.json}"
