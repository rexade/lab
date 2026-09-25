# Pi Pulse architecture

Pi Pulse is the lab's control plane: an Express API + React dashboard on the Pi
(port 8089, loopback, behind Cloudflare Access) that shows host telemetry, runs
the **core lab loop** (`run-lab.sh`, the host improving itself), and runs any
number of **incubator slots** (Codex/Claude agents iterating on their own
project repos).

```
 browser ──HTTP/SSE──► src/pi-pulse/server.js      routes, boot, schedulers, SPA fallback
                         ├ server/security.js       write guard (token / CF Access), app sandbox
                         ├ server/service-health.js stale-source gate on mutating routes
                         ├ server/core-lab.js ────► run-lab.sh (claude) | run-codex-incubator.sh
                         ├ server/incubator-store.js  incubators.json, status.json repair, launchers
                         ├ server/incubator-runs.js   preflight, spawn, scheduler, fuses
                         ├ server/run-lock.js         one run at a time, output capture
                         ├ server/run-receipts.js     FAILED rows for blocked/dead runs
                         ├ server/run-logs.js + server-core.js   RUN_LOG parsing
                         ├ server/local-ai.js         qwen critic + MemPalace context
                         ├ server/system-stats.js     /proc telemetry, 24h day buffer
                         └ server/events.js           SSE channels
                                   │
                                   │ bash projects/<slug>/run-<slug>.sh <status.json> [type]
                                   ▼
                       src/pi-pulse/scripts/run-incubator.sh   one runner for both agents
                         ├ lib/incubator-run.mjs    config · recent-runs · repair-block ·
                         │                          quality-fallback · update-status · harvest-learning
                         ├ lib/godot-ai-bridge.sh   optional Godot MCP bridge (Codex)
                         └ app-evidence.mjs         headless-browser evidence for web apps
```

## Module map

| Module | Owns |
|--------|------|
| `server.js` | Express routes, generated-app `/play/*` mounts, boot order, scheduler intervals, RUN_LOG watch, `/api` JSON error + 404 registered before the SPA fallback |
| `server/config.js` | Every path/env knob. All are overridable, so the smoke test runs the real server against a temp lab |
| `server/util.js` | Path containment, atomic JSON writes, shell quoting, SSE helpers |
| `server/security.js` | Write auth (proxied writes need a CF Access identity or the admin token), generated-app security headers, app → control-API write block |
| `server/service-health.js` | Source fingerprint at boot; mutating routes return `STALE_SERVICE_SOURCE` until restart |
| `server/incubator-store.js` | `incubators.json` (refuses to overwrite a corrupt file), status normalization/repair, Claude relay setup, project scaffold |
| `server/incubator-templates.js` | Pure: slugs, titles, roles, prompt templates, launcher template |
| `server/incubator-runs.js` | Preflight → lock → spawn; autonomous scheduler with failure fuse, plateau/north-star strategy shifts, persisted-bypass pause |
| `server/core-lab.js` | Core lab runners, core schedule, status sync |
| `server/run-lock.js` | Global lock file + detached spawn with output capture and failure receipts |
| `server/run-receipts.js` | FAILED rows for preflight blocks and processes that die before writing a summary |
| `server/run-logs.js` | Cached (mtime+size) RUN_LOG parsing, steering-note appends |
| `server-core.js` | Pure parsers + preflight checks (unit-tested directly by `trust-fixtures.mjs`) |

## Invariants

- **RUN_LOG.md format is an API.** `## Run N — DATE — TYPE` headers and
  `<!-- stdout from run N DATE -->` blocks are parsed by `server-core.js`; run
  numbers are derived by grepping headers.
- **Stable runner paths.** `status.json` files on the Pi reference
  `scripts/run-codex-incubator.sh` and `src/pi-pulse/scripts/run-claude-incubator.sh`;
  both remain as shims. Launchers are generated and self-heal (`writeIncubatorLauncher`).
- **`status.json` owns the runner choice.** `incubators.json` only holds the slot
  list and schedule state.
- **Autonomy never bypasses sandboxes.** Scheduled runs set
  `PI_PULSE_SCHEDULED_RUN=1` and the runner ignores bypass flags; persisted
  bypass flags pause schedules (`PERSISTED_BYPASS_DISABLED`).
- **One run at a time** across core + slots (`GLOBAL_RUN_LOCK_ACTIVE`).
- **Quality is evidence-capped.** App evidence can only lower a self-reported
  gate or rating; missing fields produce a conservative fallback block.
- `npm run build` runs `test:trust` first: `trust-fixtures.mjs` (unit, source
  contracts, runner behavior with fake agents) and `trust-smoke.mjs` (live server).

## Cleanup log

1. **Split the 3.1k-line `server.js`** into the modules above; `server.js` is now
   routes + boot. Route contracts are unchanged except the removals in (3).
2. **Unified the incubator runners.** `run-codex-incubator.sh` (533 lines) and
   `run-claude-incubator.sh` (361 lines) were ~90% copy-paste with a python3
   dependency and a dozen inline `node -e` snippets. They are now one
   `run-incubator.sh` + `lib/incubator-run.mjs`; the old paths are 8-line shims.
   Parity fixes: Claude runs now get the signal-feeder role, benchmark suite,
   global learnings, learning harvest, and post-run RECENT_RUNS refresh that
   were Codex-only; Codex no-summary receipts now include an output excerpt.
3. **Removed the retired single-mount subsystem**: `mounted.json` loader,
   `/api/child/*`, `/api/projects/list|mount`, the child scheduler, singular
   `/api/narration` (the UI uses `/api/narrations`), and dead UI components
   (`BottomPanel.jsx`, `AiPanel.jsx`; 1.3k lines, imported nowhere). The
   write-only `runner` copy on `incubators.json` slots is dropped on read, so
   `status.json` is the single source for the runner choice.
4. **Bugs fixed**
   - Runners hardcoded `df -Pm /home/admin` and died off-Pi. The disk guard now
     checks the project filesystem and is skipped if `df` fails; the live smoke
     test now passes on any machine.
   - A corrupt `incubators.json` was overwritten *on read* with a hardcoded
     single-slot default (`rat-deposit`), losing every slot. It is now served as
     empty with a warning and writes are refused (409) until it is repaired; a
     missing file starts empty instead of seeding a hardcoded slot.
   - Launchers exec'd the runner directly (broke if the exec bit was lost) and
     interpolated the status path unescaped; they now `exec bash` with an
     escaped default.
   - Spawned runs now receive `LAB_DIR` from the server, so runner and server
     agree on the lab root.
   - `run-lab.sh`'s post-run build check now also watches `server/`,
     `server-core.js`, and `scripts/`.

## Proposed next steps (not done)

- **Move raw stdout out of the core `RUN_LOG.md`.** It is ~5 MB, mostly agent
  transcripts. Archive stdout under `stdout/` (as incubators already do) and keep
  structured entries only; check how the UI renders older stdout-only rows first.
- **Make GETs side-effect free.** `GET /api/incubators` normalizes and rewrites
  `status.json`/launchers. Move repair to boot + write routes so GETs are pure
  reads (the trust fixtures currently pin repair-on-read).
- **Split `server.js` routes** into `routes/core.js`, `routes/incubators.js`,
  `routes/ai.js` once the route-ordering fixture is adapted.
- **Generalize the Godot hook** into per-slot pre-run tooling instead of
  hardcoded Pi paths.
- **Separate config from runtime state.** `projects/*/status.json` last-run
  fields and `incubators.json` schedule timestamps churn in git.
