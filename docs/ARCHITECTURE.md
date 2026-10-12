# Pi Pulse architecture

Pi Pulse is the lab's control plane: an Express API + React dashboard on the Pi
(port 8089, loopback, behind Cloudflare Access) that shows host telemetry, runs
the **core lab loop** (`run-lab.sh`, the host improving itself), and runs any
number of **incubator slots**: ideas that autonomous Codex/Claude sessions
shape, build, polish and finish in their own project repos, with the lab
keeping or reverting each session and an independent agent reviewing it.

```
 browser ──HTTP/SSE──► src/pi-pulse/server.js      routes, boot, schedulers, SPA fallback
                         ├ server/security.js       write guard (token / CF Access), app sandbox
                         ├ server/service-health.js stale-source gate on mutating routes
                         ├ server/core-lab.js ────► run-lab.sh (claude) | run-codex-incubator.sh
                         ├ server/incubator-store.js  incubators.json, status.json repair, launchers
                         ├ server/incubator-runs.js   preflight, spawn, scheduler, backoff
                         ├ server/run-lock.js         one run at a time, output capture
                         ├ server/run-receipts.js     FAILED rows for blocked/dead runs
                         ├ server/run-logs.js + server-core.js   RUN_LOG parsing
                         ├ server/local-ai.js         optional qwen critic API + MemPalace context
                         ├ server/system-stats.js     /proc telemetry, 24h day buffer
                         └ server/events.js           SSE channels
                                   │
                                   │ bash projects/<slug>/run-<slug>.sh <status.json>
                                   ▼
                       src/pi-pulse/scripts/run-incubator.sh   one session, either agent
                         ├ lib/incubator-run.mjs    config · session-begin · session-prompt · session-end ·
                         │                          review-prompt · review-apply · recent-runs
                         ├ lib/session.mjs          stages, prompts, git keep/revert, checks, review parsing
                         ├ lib/godot-ai-bridge.sh   optional Godot MCP bridge (Codex)
                         └ app-evidence.mjs         headless-browser screenshots/errors for web apps
```

## Module map

| Module | Owns |
|--------|------|
| `server.js` | Express routes, generated-app `/play/*` mounts, boot order, scheduler intervals, RUN_LOG watch, `/api` JSON error + 404 registered before the SPA fallback |
| `server/config.js` | Every path/env knob. All are overridable, so the smoke test runs the real server against a temp lab |
| `server/util.js` | Path containment, atomic JSON writes, shell quoting, SSE helpers |
| `server/security.js` | Write auth (proxied writes need a CF Access identity or the admin token), generated-app security headers, app → control-API write block |
| `server/service-health.js` | Source fingerprint at boot; mutating routes return `STALE_SERVICE_SOURCE` until restart, and an idle service under systemd restarts itself once new source has settled and parses/imports cleanly |
| `server/incubator-store.js` | `incubators.json` (refuses to overwrite a corrupt file), status normalization/repair, Claude relay setup, project scaffold (stage `shaping`) |
| `server/incubator-templates.js` | Pure: slugs, titles, launcher template |
| `server/incubator-runs.js` | Preflight → lock → spawn; autonomous scheduler: unproductive slots back off and retry by themselves, finished (`done`) projects rest, nothing switches autopilot off |
| `scripts/lib/session.mjs` | The session model: stages and their transitions, the builder and reviewer prompts, review parsing, the keep-or-revert rule (hard breakage only), git baseline/commit/revert, the lab's checks, RUN_LOG field placement |
| `server/core-lab.js` | Core lab runners, core schedule, status sync |
| `server/run-lock.js` | Global lock file + detached spawn with output capture and failure receipts |
| `server/run-receipts.js` | FAILED rows for preflight blocks and processes that die before writing a summary |
| `server/run-logs.js` | Cached (mtime+size) RUN_LOG parsing, steering-note appends |
| `server-core.js` | Pure parsers + preflight checks (unit-tested directly by `trust-fixtures.mjs`) |

## Dashboard

`src/` is layered so behavior can be tested without a browser:

| Layer | Owns |
|-------|------|
| `lib/` | Pure view models: `incubator.js` (stages; one state per slot, most urgent first: running, blocked, failed, paused, resting, scheduled, manual; review state; the "while you were away" digest; hero sentence; six-hour schedule), `runHistory.js` (session outcomes, timeline order, pinned unrecovered failure, failure headlines), `api.js` (JSON guard: HTML responses become explicit errors), `format.js` |
| `hooks/` | Data: `useIncubators` (SSE + 30s poll, actions), `useSystemStats` (last real sample, never simulated), `useNow` |
| `components/` | `TopBar`, `LoopHero` + `LoopDial` (what runs now, what fires next, what the lab did while you were away, what needs setup), `Roster`, `IncubatorDetail` (stage track, latest screenshot vs the one before, the builder's brief, last/next session, the independent review), `RunTimeline`, `PulsePanel` (System tab), `ServicesView` |

`npm run preview:lab` serves the real server against a seeded throwaway lab
(port 8090) with one slot in each state (building with real before/after
screenshots when a Chromium is available, polishing mid-session, failing and
retrying, blocked, done and resting), for design work off the Pi.

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
  bypass flags are cleared and recorded (`PERSISTED_BYPASS_DISABLED`).
- **One run at a time** across core + slots (`GLOBAL_RUN_LOCK_ACTIVE`).
- **The lab, not the agent, decides what is kept.** Every incubator session
  ends in a commit or a revert to its baseline. Only hard, objective breakage
  compared with the baseline reverts (a check that passed now fails, a blank
  page, new page or console errors); the app harness's softer heuristics never
  do. `reports/` is never reverted. The lab only commits in a repo it owns
  outright (never inside another repo) and never pushes.
- **Agents never grade themselves.** A fresh, read-only agent reviews each kept
  session against the builder's `BRIEF.md`; its verdict (not a self-reported
  gate) moves the stage and shows as the rating. Core Claude and Codex runs
  both enter through `run-lab.sh` and use the same controller. Their prompts
  remain the freeform create/mutate/research rotation (harvest is manual).
  Core reviews judge the seed, not milestones; core runs never graduate to done.
- **Kept is not verified completion or release approval.** Missing automated
  checks and absent browser evidence cannot certify a milestone. A failed or
  incomplete browser probe blocks completion even when it is insufficient
  evidence for a rollback. Completion requires a passing check or browser
  inspection, no failed checks, and a successful independent milestone review.
  A non-web project may use a passing check script without browser evidence.
- **Core verification runs in `src/pi-pulse`.** Its build includes the trust
  fixtures, UI rendering checks and API smoke tests. The static-app browser
  harness cannot inspect the server-backed dashboard and is explicitly
  unavailable for core sessions; this is not visual proof. Root run history,
  steering, memory, project status and evidence survive core rollback.
- **Unattended Claude runs name a permission mode.** `-p` cannot answer
  prompts, so the runner passes `--permission-mode` (`claudePermissionMode`,
  default `auto`) unless a manual run is bypassed.
- **Nothing waits for a person.** Unproductive sessions back off and retry
  (capped at 12 h), the old failure fuse's pauses resume at boot, persisted
  bypass flags are cleared without pausing, finished projects rest until a
  note wakes them, and new server code loads itself when the lab is idle
  (`PI_PULSE_AUTO_RESTART=0` opts out). Notes are read by the next session
  first and count as new until a session that saw them is kept.
- `npm run build` runs `test:trust` first: `trust-fixtures.mjs` (units and
  runner behavior with fake agents), `trust-ui.mjs` (the real JSX rendered to
  markup and checked for what a person must see), and `trust-smoke.mjs` (the
  live server against a temp lab), plus `test:verification` (completion evidence
  and core controller checks/rollback for both agents).

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

5. **2026-09 review** (each fix has a fixture that fails without it)
   - Scheduled runs never fired: every registry read, the scheduler tick's
     own included, pushed an overdue slot a full interval forward before the
     tick could see it. Only boot moves overdue slots now.
   - Headless Claude runs passed no permission mode, so edits were denied
     unless the Pi's own Claude settings allowed them; the retired-model list
     also rewrote the valid `fable` alias to `sonnet`.
   - Successful transcripts that quoted an error were counted as FAILED (33
     rows on the real core log, 19 after); only leading failure lines count.
   - Stop did not reach runs recovered from the lock after a restart; spawn
     errors leaked the global lock; a busy lock counted as a slot failure.
   - `/play/*` served dotfiles (`.git/config`); same-site-only writes are now
     enforced with `Sec-Fetch-Site`; the admin token compare is constant-time.
   - The dashboard was rebuilt around the loop (see Dashboard above).

6. **Removed handover and prompt noise** (2026-09-27)
   - The failure fuse switched autopilot off after five failures, API
     outages included, and waited for a person; failures now back off.
   - Forced "research" strategy shifts (no code changes allowed) are gone.
   - Every prompt carried the tail of `INCUBATOR_LEARNINGS.md` (74% of a
     product prompt; 84 of 91 lessons were about benchmark receipts from two
     retired incubators) and a role guessed from the idea's wording; both
     are gone, as is the lesson harvest.
   - `create` ("build the first tiny prototype") re-ran on every 4th run of
     idea-box incubators; it now runs only first.
   - The dashboard's "Next run" showed a goal written once at creation; it
     now shows the newest run's own next step.

7. **Sessions instead of a rotation** (2026-09-27)
   - Incubators no longer cycle create/mutate/research prompt files. Each
     session owns one goal end to end with a short prompt built by the lab:
     the idea, the stage, the builder's own `BRIEF.md`, new notes, the last
     review's problems, the last outcome, and the limits.
   - The lab commits kept sessions and reverts broken ones (git), so an
     unattended run can no longer leave the product worse.
   - A fresh read-only agent reviews every kept session; the retired 16-field
     self-graded form, recovery-mode keyword triggers and the local qwen
     critic panel are gone from incubators (the critic's API remains).
   - Projects move shaping → building → polishing → done and rest when done.
   - The dashboard answers "what did the lab do while I was away": the
     latest screenshot next to the previous one, the brief's done-list, the
     outcome of each session, and the review.

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
