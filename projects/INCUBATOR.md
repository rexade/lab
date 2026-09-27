# Pi Pulse — Incubator Slots

Pi Pulse runs any number of **incubator slots** side by side. Each slot is one
project with its own repo, prompts, run log, schedule, and runner (Codex or
Claude). Slots are listed in `projects/incubators.json`; the Lab tab shows
them all. No restart is needed to add, remove, or switch a slot.

> The old single-project "mount" flow (`mounted.json`, `/api/child/*`,
> `/api/projects/mount`) was retired. Slots replaced it.

---

## Create a slot

**From the UI (recommended):** Lab tab → describe the idea in the roster's create box.
`POST /api/incubators/create { idea, title? }` scaffolds:

```
/home/admin/<slug>/                     ← project repo
  prompts/{create,mutate,research}.md   ← run-type prompts (edit freely)
  reports/RUN_LOG.md                    ← run history (parsed by the UI)
  reports/USER_FEEDBACK.md              ← steering notes from the UI
/home/admin/lab/projects/<slug>/
  status.json                           ← slot config + last-run state
  run-<slug>.sh                         ← generated launcher (do not hand-edit)
```

**From an existing project:** create `projects/<name>/status.json` (below), then
`POST /api/incubators { "project": "<name>" }`.

### `status.json`

```json
{
  "project": "your-project",
  "repo": "/home/admin/your-project",
  "runLog": "/home/admin/your-project/reports/RUN_LOG.md",
  "runner": "codex",
  "runTypes": ["mutate", "research", "mutate"]
}
```

| Field | Purpose |
|-------|---------|
| `project` | Slot id / display fallback (`displayName` wins when set) |
| `repo` | Project repo. Must live under `/home/admin` and outside the lab repo |
| `runLog` | `RUN_LOG.md` inside `<repo>/reports/` |
| `runner` | `codex` or `claude`; switch it from the UI (`POST /api/incubators/:id/runner`) |
| `runTypes` | Rotation; the run type is `runTypes[runCount % length]` unless one is requested. `create` only ever runs first |
| `promptDir` | Defaults to `<repo>/prompts`; needs `<runType>.md` for each run type |
| `incubatorRole` | Legacy, ignored. Runs no longer get a role guessed from the idea, the benchmark suite, or the shared `INCUBATOR_LEARNINGS.md` receipts |
| `codexModel` / `claudeModel` | Optional model pins. Aliases (`sonnet`, `opus`, `fable`) are kept; retired dated pins fall forward to `sonnet`. Claude runs on any other model add `--fallback-model sonnet` |
| `claudePermissionMode` | How unattended Claude runs handle tool permissions: `auto` (default), `acceptEdits`, `dontAsk`, `default`, `plan`. Env `CLAUDE_PERMISSION_MODE` sets the lab-wide default. Headless `-p` runs cannot answer prompts, so a prompting mode denies edits |
| `godotAi` | Optional `{ enabled, mcpUrl, statusUrl, serverVersion, log }`; Codex runs start the Godot MCP bridge first |

On first read the server **normalizes** the file: it fills `promptDir`,
`recentRuns`, `feedbackPath`, `runTypes`, writes `launcher` / `runScript`
(the generated `run-<slug>.sh`), sets `claudeRunScript`, forces `codexBypass` /
`claudeBypass` to `false`, and creates any missing prompt or log files. Paths that
point outside the project are replaced with the defaults.

---

## How a run works

```
UI / scheduler ─► preflight (script, binary, model, prompt, log)
              ─► projects/<slug>/run-<slug>.sh            (launcher)
              ─► src/pi-pulse/scripts/run-incubator.sh    (one runner, both agents)
                   agent = $PI_PULSE_AGENT or status.runner
                   prompt = <promptDir>/<type>.md + operating rules + feedback/recovery/app-evidence blocks
                   codex exec … | claude -p …   (timeout, stdout → reports/stdout/<agent>-run-N.log)
                   RUN_LOG receipt → app evidence → quality fallback → status.json
```

`scripts/run-codex-incubator.sh` and `src/pi-pulse/scripts/run-claude-incubator.sh`
are thin, stable entrypoints that set `PI_PULSE_AGENT` and exec the unified
runner. JSON/RUN_LOG handling lives in `src/pi-pulse/scripts/lib/incubator-run.mjs`.

Scheduled runs set `PI_PULSE_SCHEDULED_RUN=1`, which disables bypass flags no
matter what the service environment says. Manual runs honor `CODEX_BYPASS=1` /
`CLAUDE_BYPASS=1` from the service environment only.

Only one run (core lab or any slot) is active at a time — see the global run
lock in `src/pi-pulse/server/run-lock.js`.

Every run gets the same short **operating rules**: own one problem end to end
(investigate, change, verify, report), report only what was verified, decide
product questions itself, and design around anything out of reach (credentials,
hardware, sudo, system services). Runs are unattended and never hand work to a
person.

**Failures back off; nothing switches autopilot off.** After a failed run the
slot waits longer before retrying (one extra interval, then three, seven…,
capped at 12 hours) and then tries again by itself; the first good run resets
the wait. Slots that the retired failure fuse switched off resume at the next
service start. Only a person turns autopilot off.

**Recovery mode** answers the newest steering note only (the last
`## <timestamp>` section of `reports/USER_FEEDBACK.md`; `## Seed` is the idea,
not feedback). A critical note puts the next runs in recovery; a later note
without a complaint ends it. Older notes stay in the prompt as context.

---

## Run log format

The agent should append an entry per run; the runner writes a conservative
receipt when it does not.

```markdown
## Run 12 — 2026-04-10 — MUTATE

**What I changed:** One sentence summary
**North star:** …
**Quality gate:** PASS | NEEDS-EVIDENCE | FAIL
**Quality rating:** 3/5
**Evidence confidence:** 4/5
**Next move:** Next concrete action
```

Header: `## Run <N> — <date> — <TYPE>` (em dash or hyphen). See
`INCUBATOR_QUALITY.md` for the full quality contract. App evidence (headless
browser checks for web apps) can only lower a self-reported gate or rating.

---

## AI analysis (optional)

`POST /api/incubators/:id/ai/analyze` asks the local qwen critic (disabled unless
`PI_PULSE_ENABLE_LOCAL_LLM=1`) about the slot's recent runs and caches the
result; `GET /api/incubators/:id/ai/latest` reads the cache.
