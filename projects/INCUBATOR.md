# Pi Pulse — Incubator Slots

Pi Pulse runs any number of **incubator slots** side by side. Each slot is one
idea being built on its own: a project folder, a run log, a schedule, and an
agent (Codex or Claude). Slots are listed in `projects/incubators.json`; the Lab
tab shows them all. No restart is needed to add, remove, or switch a slot.

**Your part is an idea, and optionally a note now and then.** The lab turns the
idea into a brief, builds it session by session, keeps only what does not make
the product worse, has an independent reviewer judge each result, polishes it,
and rests it when it is done. Nothing waits for you.

> The old single-project "mount" flow (`mounted.json`, `/api/child/*`,
> `/api/projects/mount`) was retired. Slots replaced it.

---

## Create a slot

**From the UI (recommended):** Lab tab → **+ New** → describe the idea.
`POST /api/incubators/create { idea, title? }` scaffolds:

```
/home/admin/<slug>/                     ← project folder (becomes a git repo on the first session)
  README.md                             ← the seed idea
  reports/USER_FEEDBACK.md              ← `## Seed` = the idea; your notes are appended here
  reports/RUN_LOG.md                    ← session history (parsed by the UI)
/home/admin/lab/projects/<slug>/
  status.json                           ← slot config + session state (stage "shaping")
  run-<slug>.sh                         ← generated launcher (do not hand-edit)
```

**From an existing project:** create `projects/<name>/status.json` (below), then
`POST /api/incubators { "project": "<name>" }`. Its first session writes a
`BRIEF.md` describing what already exists and continues from there.

### `status.json`

```json
{
  "project": "your-project",
  "repo": "/home/admin/your-project",
  "runLog": "/home/admin/your-project/reports/RUN_LOG.md",
  "runner": "codex"
}
```

| Field | Purpose |
|-------|---------|
| `project` | Slot id / display fallback (`displayName` wins when set) |
| `repo` | Project folder. Must live under `/home/admin` and outside the lab repo |
| `runLog` | `RUN_LOG.md` inside `<repo>/reports/` |
| `runner` | The builder: `codex` or `claude`; switch it from the UI (`POST /api/incubators/:id/runner`) |
| `reviewer` | Optional `codex` or `claude`; defaults to the builder's agent in a fresh, read-only session. Set the other one for a second model's eyes |
| `review` | `false` turns the independent review off (it costs one short agent call per kept session) |
| `stage` | Written by the lab: `shaping` → `building` → `polishing` → `done` |
| `codexModel` / `claudeModel` | Optional model pins. Aliases (`sonnet`, `opus`, `fable`) are kept; retired dated pins fall forward to `sonnet`. Claude runs on any other model add `--fallback-model sonnet` |
| `claudePermissionMode` | How unattended Claude sessions handle tool permissions: `auto` (default), `acceptEdits`, `dontAsk`, `default`, `plan`. Env `CLAUDE_PERMISSION_MODE` sets the lab-wide default. Headless `-p` runs cannot answer prompts, so a prompting mode denies edits |
| `godotAi` | Optional `{ enabled, mcpUrl, statusUrl, serverVersion, log }`; Codex sessions start the Godot MCP bridge first |
| `runTypes`, `promptDir`, `incubatorRole` | Legacy, ignored. Sessions follow the stage, and their prompt is built by the lab (`src/pi-pulse/scripts/lib/session.mjs`). Old `prompts/` folders are left on disk as background |

On read the server **normalizes** the file: it fills `recentRuns` and
`feedbackPath`, writes `launcher` / `runScript` (the generated `run-<slug>.sh`),
sets `claudeRunScript`, forces `codexBypass` / `claudeBypass` to `false`, and
creates a missing run log. Paths that point outside the project are replaced
with the defaults.

---

## How a session works

```
scheduler / Run ─► preflight (launcher, repo, run log, agent binary, model)
                ─► projects/<slug>/run-<slug>.sh
                ─► src/pi-pulse/scripts/run-incubator.sh      one runner, both agents
   session-begin   stage; git baseline (init/adopt the folder; stash an interrupted session's leftovers); baseline checks
   builder         one agent owns one goal end to end: builds, runs the product, checks its own work
   session-end     the lab's checks, then KEEP (commit) or REVERT to the baseline; outcome into RUN_LOG + status
   review          a fresh read-only agent judges the product against BRIEF.md → reports/REVIEW.md
```

**The builder's prompt** is short and about this project only: the idea, the
stage, `BRIEF.md`, your new notes (they come first), the last review's top
problems, the last outcome, and the limits (no sudo, no services, nothing
outside the folder, nobody to ask: design around it). It ends by asking for a
plain entry in `reports/RUN_LOG.md`.

**Keep or revert.** The lab, not the agent, decides what is kept. It runs the
project's own check (`./check.sh`, else `npm run build` / `npm test`) and, for
web apps, opens `index.html` in a headless browser (screenshots, errors, blank
page). A session is **reverted** only on hard, objective breakage compared with
before it: a check that passed now fails, the page went blank, or there are new
uncaught or console errors. Everything else is committed as "Pi Pulse lab" on
the folder's current branch (never pushed). `reports/` is never reverted, so
the history of a reverted session survives, and the next session is told why.

**The independent review** runs after every kept session: a separate agent in a
fresh session, allowed only to read, looks at the screenshots and the code the
way the person who asked would, and answers with a verdict, a 0–5 rating,
whether the brief's "Done means" list is met, its top problems, and what to
cut. That review steers the next session, and it moves the stage.

**Stages.** `shaping` writes `BRIEF.md` (what it is, for whom, what done means,
constraints) and a first version → `building` works toward "Done means" → when
the reviewer says the brief is met, `polishing` (no new features; clearer,
sturdier, simpler) → after two polish passes (`PI_PULSE_POLISH_SESSIONS`),
`done`. A done project **rests**: autopilot stays on but no sessions run. A new
note wakes it (back to building); **Run** gives it one more polish pass.

**Nothing waits for a person.** Failed, reverted, and (while building)
no-change sessions back off: one extra interval, then three, seven…, capped at
12 hours, and the first good session resets the wait. Nothing switches
autopilot off. A project folder inside another git repository runs without
keep/revert (the lab never commits there) and says so in Runner details.

Scheduled sessions set `PI_PULSE_SCHEDULED_RUN=1`, which disables bypass flags no
matter what the service environment says. Manual runs honor `CODEX_BYPASS=1` /
`CLAUDE_BYPASS=1` from the service environment only. Only one run (core lab or
any slot) is active at a time — see the global run lock in
`src/pi-pulse/server/run-lock.js`.

Knobs: `CLAUDE_TIMEOUT` / `CODEX_TIMEOUT` (builder, default 2400 s),
`REVIEW_TIMEOUT` (900 s), `CHECK_TIMEOUT` (600 s), `PI_PULSE_REVIEW=0` (review off
lab-wide), `PI_PULSE_MAX_BACKOFF_HOURS` (12).

---

## Run log format

The builder appends one entry per session; the lab adds its own fields to that
same entry (and writes a receipt when the builder did not).

```markdown
## Run 12 — 2026-09-27 — BUILD

**Goal:** a new player knows what to press on the first screen
**What changed:** one obvious Play button; the rules moved behind a link
**Verified:** opened it at phone size and played a round
**Next:** sound on hits, off by default
**Checks:** ./check.sh pass · app opened cleanly
**Outcome:** kept · 9b7e310
**Ended:** 2026-09-27T10:32:11Z
**Review:** better · 4/5 · not done yet — No sound when a card hits
```

Header: `## Run <N> — <date> — <TYPE>` with TYPE `SHAPE`, `BUILD`, `POLISH`, or
`FAILED` (older `CREATE`/`MUTATE`/`RESEARCH` entries still parse). Outcomes:
`kept`, `no changes`, `reverted — <why>`, `failed — <why>`.
