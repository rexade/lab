# lab — a feral Pi incubator

A Raspberry Pi-hosted creative incubator for autonomous AI work.

Pi Lab runs repeated create/mutate/research loops against mounted projects. It keeps memory, taste feedback, run history, failure visibility, and human steering in one small local system.

This is not a generic dashboard. It is a workshop for producing weird, shippable creative software. Steer it toward higher trust per run, not more widgets.

> **AI handover.** This file is written for the next agent that lands in this repo — Claude Code, Codex, or whatever you are. Read it end-to-end before touching anything. The invariants below are load-bearing; the taste rules are not suggestions.

---

## What this actually is

A Raspberry Pi 5 (`testpi`) running a self-directed creative lab. **Its purpose is to let AI be creative — to produce real things.** Not to run experiments for their own sake. The lab exists so that autonomous Claude Code turns can incrementally push shippable creative work forward: models, tools, apps, artifacts, whatever the mounted project is chasing.

Two layers, don't conflate them:

- **The workshop** — this repo. `src/pi-pulse/` (a Node+React dashboard at `localhost:8089`, public via Cloudflare Tunnel at `home.rexthedog.space` and `pipulse.rexthedog.space`) makes the loop visible and steerable. `run-lab.sh` is the loop. MemPalace + the markdown files (`DAILY_SEED.md`, `TASTE_PROFILE.md`, `RUN_LOG.md`, `ACTIVE_THREADS.md`, etc.) give the loop continuity across turns. Optimize this layer for **signal, not features** — every widget you add is scaffolding you'll have to maintain instead of ship.
- **The products** — whatever gets mounted as a child project. Today: `race-whisperer-predict` (V85 horse-race analysis). Historically the ghost/whisper/oracle quartet, the narrator, and pi-pulse's own visual identity have all been shaped by this loop. Products live in their own repos with their own `run-<name>.sh` scripts; the workshop hosts them and drives the AI turns against them. Optimize this layer for **shippable creative output**.

The workshop is not itself a product. But its whole reason to exist is to produce them.

---

## The Loop

```
DAILY_SEED.md  (human, edited rarely)
       │
       ▼
generate-brief.sh                       ← rebuilds MEMORY_BRIEF.md from MemPalace
       │                                  wake-up (L0+L1, ~170 tokens) + live seed + threads
       ▼
run-lab.sh <create|mutate|research>     ← default: rotates create → mutate → research → mutate
       │                                  based on run count (RUN_LOG.md grep)
       ▼
claude --print --model sonnet …         ← headless Claude Code call with prompt from prompts/
       │                                  Constrained tool allowlist. Reads MEMORY_BRIEF + DAILY_SEED.
       ▼
stdout → appended to RUN_LOG.md         ← Claude ALSO edits RUN_LOG.md and ACTIVE_THREADS.md directly
       │                                  per the prompt contract.
       ▼
save-run.sh                             ← extracts the run's summary into memory/runs/run-NNN.md
       │                                  then mines memory/ into MemPalace for future briefs
       ▼
pi-pulse UI (SSE watch on RUN_LOG.md)   ← live-updates without reload
```

**Rotation:** `create → mutate → research → mutate`. `harvest` is manual-only (`./run-lab.sh harvest`) and consolidates. Each type has its own prompt in `prompts/`.

**Trigger:** Currently invoked either by a systemd timer, by the pi-pulse UI's "Run Lab" button (`POST /api/run`), or the incubator auto-schedule (`POST /api/child/schedule` — fires the *mounted* child project on an interval).

---

## Why freeform, not milestone-driven

If your training tells you to impose milestones, a `PATH.md`, machine-checked pass/fail verdicts, or any "closed-loop with a codified standard" discipline on this system — **don't**. That design was fully explored on 2026-07-03 and deliberately rejected in favor of freeform seed+rotation.

The short version of why:
- **The workshop's purpose is creativity.** Milestone/verdict discipline is a convergence engine — it collapses the search space to prove a specific claim. Creativity needs the opposite: latitude to find claims worth making. Locking taste-work behind checkboxes would Goodhart exactly what makes AI turns generative here.
- The current loop produces results the human is content with. Empirical signal beats theoretical rigor.
- The `mutate.md` prompt ("the seed is law", "one meaningful change beats ten small tweaks", "do not fix things the seed does not ask you to fix") is already a strong prior.
- MemPalace + `DRIFT_FEEDBACK.md` (a tiny local `qwen2.5:1.5b` critic via hailo-ollama) provides soft accountability without collapsing possibility.

Freeform is the pro-creativity engine. Milestones are the pro-shipping engine. Both matter, but you use them in that order: create, then converge.

The one signal that would justify introducing milestone discipline for a specific product: a **binary shipping gate** — e.g. "V32 beats DEFAULT_WEIGHTS on the named May 2026 holdout → promote." That's when a product has converged enough that "does it beat X" is answerable. No product is at that threshold today. If the human ever says "help me ship X" or "prove Y beats baseline," ask before adding structure — that's the conversation where milestones might come back on the table for that specific product, without changing how the workshop drives everything else.

---

## Files you MUST read before working

In this order. Do not skip any of them. Do not read implementation files first.

1. **`DAILY_SEED.md`** — today's direction. **The seed is law.** If it says "do not add multi-project UI", do not add it. If it says "strengthen visual identity", do that, not something easier. The seed overrides your own instincts about what looks broken.
2. **`TASTE_PROFILE.md`** — stable aesthetic constraints. **Hard constraints are hard.** No enterprise admin panel look. No generic dashboard grids. No Bootstrap. Dark mode first, always.
3. **`MEMORY_BRIEF.md`** — the pre-run wake-up brief. Palace context + seed direction + active thread. Regenerated by `generate-brief.sh` each turn. You read this; you don't write it.
4. **`ACTIVE_THREADS.md`** — 3–5 live ideas. Continue promising threads unless the seed says otherwise. You rewrite this at end of each turn.
5. **`RUN_LOG.md` tail** — last few runs. Format is `## Run N — DATE — TYPE` with bulleted fields.
6. **`BACKLOG.md`** — ideas parked for later. Don't attack these unless the seed points you there.
7. **`DRIFT_FEEDBACK.md`** — most recent qwen critique. Commentary, not verdict. Consider it a second opinion, not a mandate.
8. **`prompts/<runtype>.md`** — the actual prompt for whichever run type you're doing. Follow the output contract exactly, including the required `## Run …` heading and the `**What I changed:**` / `**Next move:**` fields.

---

## Repo layout

```
lab/
├── README.md                    ← you are here
├── run-lab.sh                   ← the loop entrypoint (rotation dispatcher)
├── generate-brief.sh            ← rebuilds MEMORY_BRIEF.md from MemPalace
├── save-run.sh                  ← extracts run to memory/runs/, mines palace
├── mempalace.yaml               ← palace config (wing: lab)
├── DAILY_SEED.md                ← human, edited rarely
├── TASTE_PROFILE.md             ← human, edited rarely
├── ACTIVE_THREADS.md            ← Claude rewrites end of each run
├── BACKLOG.md                   ← ideas parked for later
├── RUN_LOG.md                   ← every run appended; 2600+ lines and growing
├── MEMORY_BRIEF.md              ← regenerated each run (gitignored)
├── RECENT_RUNS.md               ← regenerated each run (gitignored)
├── DRIFT_FEEDBACK.md / .json    ← qwen critique output
│
├── prompts/                     ← rotation prompts
│   ├── create.md                ← BUILD one concrete thing
│   ├── mutate.md                ← IMPROVE one thing that exists
│   ├── research.md              ← INVESTIGATE and report
│   └── harvest.md               ← manual consolidation
│
├── projects/                    ← per-project incubator metadata
│   ├── mounted.json             ← which project is currently "mounted"
│   ├── schedule.json            ← auto-schedule state for the mounted child
│   ├── INCUBATOR.md             ← notes on the incubator concept
│   ├── pi-pulse/                ← the host itself, tracked as a project
│   ├── race-whisperer-predict/  ← currently mounted (V85 race analysis)
│   ├── ghost-trio/              ← dormant (see BACKLOG.md)
│   └── hatchery/                ← ??
│
├── memory/                      ← structured palace-mined notes
│   ├── decisions.md
│   ├── failures.md
│   ├── identity.md
│   ├── mempalace.yaml
│   └── runs/                    ← run-NNN.md, one per run
│
└── src/
    ├── pi-pulse/                ← Node+React dashboard (port 8089)
    ├── ghost/                   ← ghost/whisper/oracle quartet (dormant)
    └── narrator/                ← ambient narrator (ports 3031 area)
```

---

## Running things

### Fire one lab turn manually

```bash
cd /home/admin/lab
./run-lab.sh mutate      # or: create | research | harvest
```

The script figures out the next run number, generates the brief, calls Claude Code headless with the appropriate prompt, appends output to `RUN_LOG.md`, and mines the run into MemPalace. Non-interactive; safe to background.

### Start / restart the pi-pulse dashboard

Runs as a native `node server.js` process supervised by systemd (unit: `pi-pulse.service`). NOT in Docker. Port 8089.

```bash
sudo systemctl restart pi-pulse
# or on the Pi if systemd unit is missing:
cd /home/admin/lab/src/pi-pulse && npm start
```

The server reads built assets from `dist/` on each request, so a fresh Vite build is picked up without restarting the service.

### Rebuild the React frontend

```bash
cd /home/admin/lab/src/pi-pulse
npm install       # node_modules is gitignored — first clone needs this
npm run build     # emits dist/, server serves the new build on next request
```

### MemPalace CLI

Installed at `/home/admin/.local/bin/mempalace`. Common uses:

```bash
mempalace search "waveform responsiveness" --wing lab --results 3
mempalace wake-up --wing lab           # L0+L1 identity brief (~170 tokens)
mempalace mine memory/                 # re-mine structured notes into palace
```

The pi-pulse server calls `mempalace search` from Node for AI-analysis context. Do not remove the CLI.

---

## The project mount system

The incubator hosts one **mounted child project** at a time. `projects/mounted.json` points at a project's `status.json`; pi-pulse's UI has a `ProjectPanel` that shows the mounted child's runs and can trigger its run script.

```
projects/mounted.json
{
  "project": "race-whisperer-predict",
  "labStatus": "/home/admin/lab/projects/race-whisperer-predict/status.json"
}
```

Each project directory contains a `status.json` with fields like `repo`, `runLog`, `runScript`, `phase`, plus arbitrary project-specific keys (race-whisperer-predict's status.json is 2 KB of evaluation state).

**To add a new mountable project:** create `projects/<name>/status.json` with `repo`, `runLog`, `runScript`. That's it — the UI auto-discovers it via `GET /api/projects/list`. Mount it via `POST /api/projects/mount`, which rewrites `mounted.json` and exits pi-pulse's process (systemd restarts it in ~1s).

The `runScript` lives outside this repo (typically `/home/admin/run-<project>.sh`). Those scripts are the project's equivalent of `run-lab.sh` — they usually invoke Claude Code with the project's own prompt against the project's own repo.

---

## Invariants — do not violate

1. **The seed is law.** `DAILY_SEED.md` overrides your judgment. If it says "do not add X," do not add X even if adding X would fix an obvious problem.
2. **TASTE_PROFILE.md is law.** Enterprise admin panel aesthetic, generic dashboard grids, Bootstrap defaults — hard-no. Read the "What bad looks like" section before any UI change.
3. **Work only in `src/` for code changes.** Don't touch `run-lab.sh` / `generate-brief.sh` / `save-run.sh` unless the seed explicitly directs you there. They are the fabric of the loop.
4. **One meaningful change beats ten small tweaks.** The prompts say this. Believe it. Don't sprinkle refactors.
5. **Do not add dependencies** without a strong reason justified against the seed. `npm install <thing>` is a request for approval, not a decision.
6. **Do not restructure `RUN_LOG.md` format.** `server.js` parses it with two regexes (formal `## Run N — DATE — TYPE` headers and `<!-- stdout from run N DATE -->` comment blocks). Break either and the UI stops parsing history.
7. **Do not "fix" things the seed doesn't ask about.** Broken things exist by design sometimes. The seed says what deserves fixing.
8. **Do not propose milestone/verdict discipline.** See the "Why freeform" section. If you think this system needs it, you have misread it.
9. **Do not push `node_modules/` or `dist/`.** `.gitignore` handles this — do not commit around it.

---

## Landmines

- **Single-Pi single-point-of-failure.** The Pi's SD card is the only physical copy of the running system beyond this repo. If runtime state matters (day-buffer, live palace state), it lives only on the Pi. This repo is source + config + notes, not a full backup.
- **Cloudflared lockout.** The Pi is administered through a Cloudflare Tunnel. Never touch `/etc/cloudflared/config.yml` or restart `cloudflared` without understanding you can lock yourself (and the human) out until a physical reboot. The human explicitly asks to be warned before any change touching networking, Docker, or Cloudflare.
- **Port 8089 double-bind.** `pi-pulse.service` owns restarts. Do not add wrapper restart loops or port-kill guards; a busy port should fail loudly in the journal.
- **`fs.watch` unreliability.** `server.js` uses `fs.watch` on `RUN_LOG.md`. It's not guaranteed to fire on all filesystems. There's no polling fallback for RUN_LOG.md — if a run happens and the UI doesn't update, refresh the browser once and check the console.
- **qwen tokenization artifacts.** DRIFT_FEEDBACK sometimes contains garbled tokens like `"arenaught"` or `"areading"` — that's the 1.5B model breaking grammar, not corruption. Don't chase it.
- **The palace can be stale.** `save-run.sh` mines `memory/` after each run, but the source of truth for "what happened" is still `RUN_LOG.md`. Trust the log first.

---

## What "good work" looks like here

- You read `DAILY_SEED.md`, `MEMORY_BRIEF.md`, and `ACTIVE_THREADS.md` before touching code.
- You pick ONE thing that aligns with the seed and the current active thread — biased toward changes that make the mounted **product** better, not the workshop.
- You make a small, confident, tasteful change. It compiles. `npm run build` succeeds. If the change is to a mounted product, it moves that product closer to something shippable.
- You update `RUN_LOG.md` with an honest entry: what changed, why, what improved, **what broke** (do not lie about this), next move.
- You rewrite `ACTIVE_THREADS.md` to reflect the current live ideas — kill dead threads.
- You do NOT explain what the code does in comments; the prompts don't want that either.
- You do NOT add abstractions for hypothetical future work.
- You do NOT propose adopting a spec system, a milestone system, TDD, or a linter unless the seed asks for it.
- Workshop improvements are allowed and sometimes necessary, but they should be **in service of** better product turns — a UI tweak that helps you see drift is good; a new admin panel because "the UI could use one" is not.

---

## Cross-repo context

Related but distinct repositories on the same Pi and GitHub account:

- **`rexade/lab`** (this repo, PRIVATE) — the lab loop + pi-pulse + palace notes. Lives at `/home/admin/lab/`.
- **`rexade/henrik-lab`** (PUBLIC) — the Docker stack at `/home/admin/outline/` running the home services (homepage, recipes, kanban, anime, brain, outline, uptime-kuma). Separate concern. Don't merge them.
- Mounted child projects (like `race-whisperer-predict`) live in their OWN repos at `/home/admin/<project>/` and are referenced from `projects/<name>/status.json`. This repo does not vendor them.

---

## When in doubt

1. Read `DAILY_SEED.md` again.
2. Read `TASTE_PROFILE.md` again.
3. Do the smallest thing that honors both. Log it honestly. Stop.
