# Pi Pulse — Stable Identity

**Project:** Live Raspberry Pi system dashboard
**Service:** pipulse.service (systemd user, port 8089)
**Stack:** Vite + React + Tailwind + Framer Motion + Express (Node.js)
**Source:** /home/admin/lab/src/pi-pulse/
**Deploy:** `npm run build` → dist/ watched → systemd auto-restarts server
**Data sources:** /proc/stat, /proc/meminfo, /proc/net/dev, /sys/class/thermal
**AI:** qwen2.5-instruct:1.5b via hailo-ollama at localhost:8000
**Companion:** race-whisperer-predict at /home/admin/race-whisperer-predict (separate loop)
**Run loop:** create → mutate → research → mutate → repeat
**Run log:** /home/admin/lab/RUN_LOG.md
**Current run count:** ~87
