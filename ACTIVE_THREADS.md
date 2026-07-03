# Active Threads

*Updated 2026-07-03 (Run 95 RESEARCH). Active project: pi-pulse.*

- **Per-incubator local feedback** — Research confirmed `parseAnalysis` is duplicated (full version ProjectPanel.jsx:23, degraded copy AiPanel.jsx:12) and is pure string ops; next MUTATE moves it into server.js, stores `fields`/`missing`/`malformed` in DRIFT_FEEDBACK.json at analyze time, computes on read for legacy files.
- **Runner preflight reliability** — Preflight failures are currently invisible: the codex runner exits (127/1) before its first RUN_LOG write and server spawns with `stdio: 'ignore'`. Next: `GET /api/incubators/:id/preflight` endpoint + script-side trap that logs `[run failed — preflight]` so early exits become FAILED history entries.
- **Failure detail surfacing** — Working on real data (run 95 attempt 1 logged its claude model error), but the API ships one line and the UI truncates at 92 chars; next: capped `detail` field on FAILED runs from `parseStdoutRunBlocks`, expandable row in history.
- **API/static boundaries** — `/api/*` JSON 404 verified live. Remaining fallthrough: `POST /api/incubators` says `restarting: true` but never restarts, and play routes only mount at startup — runtime-added slots serve the pi-pulse SPA at their playUrl until restart.
