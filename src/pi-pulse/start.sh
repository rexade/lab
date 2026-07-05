#!/bin/bash
# Legacy compatibility entrypoint. The systemd unit should run node directly.
set -euo pipefail
cd /home/admin/lab/src/pi-pulse
exec node server.js
