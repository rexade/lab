# Pi Pulse — Failure Patterns

## Scheduling
- Claude Code rate limit resets at 10pm Europe/Stockholm — runs between 9–10pm will fail with "hit your limit". Runs 55 and 56 both failed this way. Schedule outside this window.

## Server stability
- EADDRINUSE restart storm: systemd, start.sh, and in-process listen retries fought each other. Fixed by letting `pi-pulse.service` own restarts and making the server fail loudly on listen errors.
- Two cloudflared processes can run simultaneously after restart — check with `ps aux | grep cloudflared` and kill stale one before assuming tunnel is broken.

## Data integrity
- getNetworkRate() double-call: calling buildStatsPayload() twice in one tick can corrupt byte-delta state. Fixed by caching the network rate for sub-second duplicate calls; day-buffer snapshots still build fresh payloads.
- Day buffer entries before Run 55 lack rx/tx fields — this is expected, clears naturally in 24h.

## Development
- Quadratic bezier waveform: visible angular artifacts on live CPU data. Replaced with Catmull-Rom in Run 54+. Never revert to quadratic.
- Stale onnxruntime warnings in mempalace output: benign noise from chromadb GPU probe. Filter with 2>/dev/null.
