# Pi Pulse — Incubator Onboarding

**3 steps. No code changes required.**

Pi Pulse can mount any project that has a repo, a run script, and a run log. The UI (ProjectPanel) reads from `mounted.json` at startup and displays that project's status, runs, and launch control.

---

## Step 1 — Create `projects/<name>/status.json`

Create a file at `/home/admin/lab/projects/<your-project-name>/status.json`:

```json
{
  "project": "your-project-name",
  "repo": "/home/admin/your-project-name",
  "runLog": "/home/admin/your-project-name/reports/RUN_LOG.md",
  "runScript": "/home/admin/run-your-project.sh",
  "runner": "script",
  "runCount": 0,
  "lastRun": null,
  "lastRunType": null
}
```

**Required fields:**
| Field | Purpose |
|-------|---------|
| `project` | Display name shown in the ProjectPanel header |
| `repo` | Absolute path to the project repo. Server reads `<repo>/status.json` for live runtime state |
| `runLog` | Absolute path to RUN_LOG.md. Parsed for the runs timeline |
| `runScript` | Absolute path to a bash script that starts a mutation run |

**Optional fields** (shown in the panel if present):
- `runner` — `claude`, `codex`, or `script`; documentation/status only, the backend still launches `runScript`
- `promptDir` — prompt directory for generic runners; defaults to `<repo>/prompts`
- `runTypes` — rotation for generic runners, e.g. `["mutate", "research", "mutate"]`
- `codexModel` — optional model override for Codex runs
- `codexBypass` — set `true` for unattended automation; passes Codex `--dangerously-bypass-approvals-and-sandbox`
- `runCount` — displayed as "run #N"
- `lastRun` — date string shown in header
- `lastRunType` — MUTATE / RESEARCH / CREATE

---

## Step 2 — Update `mounted.json`

Edit `/home/admin/lab/projects/mounted.json`:

```json
{
  "project": "your-project-name",
  "labStatus": "/home/admin/lab/projects/your-project-name/status.json"
}
```

Only one project can be mounted at a time. To switch projects, change this file and restart.

---

## Step 3 — Restart pi-pulse

```bash
sudo systemctl restart pi-pulse
```

The server loads `loadMountedProject()` at startup. A restart is required after changing `mounted.json`.
Verify: open Pi Pulse → Pulse tab → ProjectPanel header should show your project name.

---

## What the project repo needs

### `<repo>/status.json`
The server reads this for live runtime state and merges it with the lab status. Useful fields:

```json
{
  "current_focus": "Shown in the Focus row of ProjectPanel (preferred)",
  "next_run_goal": "Shown in the Next row of ProjectPanel",
  "notes": "Shown in the State row when current_focus is absent — model config, current weights, etc.",
  "phase": "Shown as a badge in the header — e.g. 'incubation', 'production', 'paused'",
  "run_count": 0,
  "health": "green"
}
```

### Run log format
`RUN_LOG.md` entries must follow this format for the runs timeline to parse them:

```markdown
## Run 1 — 2026-04-10 — MUTATE

**What I changed:** One sentence summary
**Why:** What was weak
**What improved:** What is better
**What broke:** Honest assessment
**Next move:** Next concrete action
```

Header format: `## Run <N> — <date> — <TYPE>`
Type must be one of: `MUTATE`, `RESEARCH`, `CREATE`

### Run script
A bash script at `runScript` path. Pi Pulse runs it detached — it should handle its own logging.

Claude-style project:

```bash
#!/bin/bash
cd /home/admin/your-project-name
claude --print "..." >> reports/run.log 2>&1
```

Codex-style project:

```json
{
  "project": "your-project-name",
  "repo": "/home/admin/your-project-name",
  "runLog": "/home/admin/your-project-name/reports/RUN_LOG.md",
  "runScript": "/home/admin/lab/scripts/run-codex-incubator.sh",
  "runner": "codex",
  "promptDir": "/home/admin/your-project-name/prompts",
  "runTypes": ["mutate", "research", "mutate"],
  "codexModel": "gpt-5",
  "codexBypass": true
}
```

`run-codex-incubator.sh` reads the currently mounted project from `mounted.json`, loads `<promptDir>/<runType>.md`, and runs:

```bash
codex exec -C "$repo" --add-dir /home/admin/lab --dangerously-bypass-approvals-and-sandbox "$prompt"
```

It appends Codex stdout to `runLog` and updates `runCount`, `lastRun`, and `lastRunType` in the project's lab status file.

---

## AI analysis (optional)

The AI strip in ProjectPanel calls `/api/child/ai/analyze`, which reads the project's run log and seed context. It expects the run log to be parseable (see format above) and queries MemPalace for seed direction. No extra setup needed — it works from the mounted project's data automatically.

---

## To switch to a new project

1. Edit `mounted.json` → point `labStatus` to the new project's status.json
2. `sudo systemctl restart pi-pulse`

That's it. The old project is unmounted. Nothing is deleted.

---

## Current mounted project

`race-whisperer-predict` — `/home/admin/race-whisperer-predict`
Mounted: 2026-04-08. Run 79+ as of 2026-04-11.
