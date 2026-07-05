# RECOVERY

> Fresh-Pi bootstrap. Assumes: bare Raspberry Pi 5 with Raspberry Pi OS installed, `admin` user, SSH access, git configured, and a `rexade` GitHub token with `repo` scope in `~/.git-credentials`.

The single-Pi single-point-of-failure warning in the README is not theoretical. If the SD card dies, this document is how you rebuild.

## What's in this repo vs. not in this repo

**In-repo** — code, configs, prompts, run history, palace notes: `src/`, `projects/`, `prompts/`, `memory/`, `run-lab.sh`, `generate-brief.sh`, `save-run.sh`, all top-level markdown state files. Everything a fresh Pi needs to reconstruct the workshop and get to the same functional state.

**Not in-repo** — must be reinstalled or re-created from external sources:

| Thing | Where it lives | How to restore |
|---|---|---|
| `node_modules/` for `src/pi-pulse/` | On the Pi only | `npm install` |
| Vite `dist/` build output | On the Pi only | `npm run build` |
| `/home/admin/.local/bin/mempalace` | Separate install | See MemPalace section below |
| `hailo-ollama` binary + qwen model | `/usr/bin/hailo-ollama` | See hailo section below |
| Cloudflared tunnel credentials | `/etc/cloudflared/` | See cloudflared section below |
| Systemd units | `/etc/systemd/system/`, `~/.config/systemd/user/` | Copies below |
| Child project repos (e.g. `race-whisperer-predict/`) | Their own GitHub repos | `git clone` each into `/home/admin/` |
| Child project runner scripts (`/home/admin/run-<project>.sh`) | Committed inside child project repos | Follow that project's own recovery |
| `DAILY_SEED.md`, `ACTIVE_THREADS.md`, `TASTE_PROFILE.md` | In-repo but human-owned | Preserved by git; if you clone fresh they come with |
| MemPalace mined index | Regenerated from `memory/` | `mempalace mine memory/` |
| `day-buffer.json` (24h rolling snapshot) | On the Pi only | Regenerates from live samples (~24h to warm up) |

## Step-by-step bootstrap

```bash
# 0. Base packages (adjust for your Pi OS version)
sudo apt update && sudo apt install -y git nodejs npm python3-pip

# 1. Clone this repo
cd /home/admin
git clone https://github.com/rexade/lab.git

# 2. Symlink the loop entrypoint at the path systemd and server.js expect
ln -s /home/admin/lab/run-lab.sh /home/admin/run-lab.sh
# (Legacy path. Both server.js:369 and lab-runner.service reference
# /home/admin/run-lab.sh. The actual file lives in the repo; the symlink
# is the compat surface.)

# 3. Install pi-pulse dependencies + build the frontend
cd /home/admin/lab/src/pi-pulse
npm install
npm run build   # emits dist/; server serves the new build on next request

# 4. Install Claude Code CLI (used by run-lab.sh)
#    See https://docs.claude.com/en/docs/claude-code — auth via OAuth
#    (`claude login`), NOT an API key. run-lab.sh unsets ANTHROPIC_API_KEY
#    at the top on purpose.

# 5. Install MemPalace CLI (see MemPalace section)

# 6. Install hailo-ollama (optional but drift-feedback needs it)

# 7. Install systemd units (see Systemd section)

# 8. Configure Cloudflared tunnel (optional, for public access)

# 9. Clone any mounted child project repos into /home/admin/
#    e.g. git clone git@github.com:<owner>/race-whisperer-predict.git
```

## Systemd units

Three matter. Copies preserved here for restoration; drop them into the correct paths and reload.

### `/etc/systemd/system/pi-pulse.service` (system)

```ini
[Unit]
Description=Pi Pulse — device console dashboard
After=network.target

[Service]
Type=simple
User=admin
WorkingDirectory=/home/admin/lab/src/pi-pulse
ExecStart=/usr/bin/env node /home/admin/lab/src/pi-pulse/server.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pi-pulse
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable: `sudo systemctl daemon-reload && sudo systemctl enable --now pi-pulse`

### `~/.config/systemd/user/lab-runner.service` (user)

```ini
[Unit]
Description=Lab runner — Claude Code headless evolution loop
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/home/admin/lab
ExecStart=/home/admin/run-lab.sh
StandardOutput=journal
StandardError=journal
Environment=HOME=/home/admin
Environment=PATH=/home/admin/.local/bin:/usr/local/bin:/usr/bin:/bin
```

### `~/.config/systemd/user/lab-runner.timer` (user)

```ini
[Unit]
Description=Run lab-runner every hour

[Timer]
OnCalendar=*:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable: `systemctl --user daemon-reload && systemctl --user enable lab-runner.timer`

**Note:** as of 2026-07-03 the timer is *inactive and disabled* on the running Pi — runs are triggered manually or via the pi-pulse UI. Restore the unit files but do not auto-enable the timer unless you're ready for hourly runs.

### `/etc/systemd/system/hailo-ollama.service` (optional, for drift-feedback)

Committed at `src/pi-pulse/hailo-ollama.service`. Copy to `/etc/systemd/system/`, install `hailo-ollama` and pull the `qwen2.5-instruct:1.5b` model, then enable.

## MemPalace

Semantic memory system that provides the L0+L1 wake-up brief. CLI at `/home/admin/.local/bin/mempalace`. Install from wherever it lives (separate repo, not in `lab/`). After install:

```bash
# Configure the lab wing
cd /home/admin/lab
mempalace mine memory/          # re-mines memory/ into palace
mempalace wake-up --wing lab    # test — should print ~170 tokens of L0+L1
```

If MemPalace is missing, `generate-brief.sh` still runs but `MEMORY_BRIEF.md`'s Palace-context section will fall back to `(palace unavailable — read TASTE_PROFILE.md and DAILY_SEED.md)`. The loop still works; it just has less context per turn.

## hailo-ollama (drift-feedback)

`server.js` calls `http://localhost:11434/api/generate` for the qwen critic. Purely optional — if it's not running, `POST /api/ai/analyze` returns 502 and the UI shows "AI unavailable". No effect on the run loop itself.

To restore: install `hailo-ollama`, pull the `qwen2.5-instruct:1.5b` model, enable `hailo-ollama.service`.

## Cloudflared

Public access to `home.rexthedog.space` and `pipulse.rexthedog.space` goes through Cloudflare Tunnel. Config lives at `/etc/cloudflared/config.yml` (NOT in this repo — root-owned, treat as sensitive). Tunnel ID and credentials must come from a separate backup or be re-issued via `cloudflared tunnel login`.

**Recovery is not blocking.** pi-pulse works fine at `http://<pi-ip>:8089` without cloudflared. Only public access via `*.rexthedog.space` requires it.

## Human blockers before productive runs

Two things a fresh Pi will have that the workshop cannot auto-solve:

1. **`DAILY_SEED.md` must be written.** If it's empty, the loop runs against no direction and produces slop. The README's invariant is explicit: *the seed is human-authored, and the seed is law.* A fresh clone preserves the current seed; if you're bootstrapping from scratch, write one before firing the first run.
2. **Verify `TASTE_PROFILE.md` still reflects your taste.** It's stable but not immutable. Re-read before letting the loop touch UI.

## Verifying a restored Pi

```bash
# Loop machinery syntax
bash -n /home/admin/lab/run-lab.sh
bash -n /home/admin/lab/generate-brief.sh
bash -n /home/admin/lab/save-run.sh

# References resolve
test -f /home/admin/run-lab.sh && echo "entrypoint symlink OK"
test -x /home/admin/.local/bin/mempalace && echo "mempalace OK"
which claude && echo "claude CLI OK"

# Services
systemctl is-active pi-pulse                  # should say active
systemctl --user is-enabled lab-runner.timer  # your choice: enabled or disabled

# Live dashboard
curl -sS http://localhost:8089/api/health     # should return {"ok": true, ...}
```

If all four command lines print without errors, the workshop is restored. Whether the loop should fire is up to you — check `DAILY_SEED.md` first.
