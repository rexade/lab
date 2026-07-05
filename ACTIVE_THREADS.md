# Active Threads

*Updated 2026-07-05 (Run 191 RESEARCH). Active project: pi-pulse.*

- **Runner authority drift is the next trust bug** — live state shows `incubators.json` can say Claude while `status.json`, preflight, and the active process still run Codex.
- **Fresh service proof is no longer the blocker** — `/api/health.source.changedSinceStart === false`, unknown `/api/*` returns JSON 404, and `npm run test:trust` passes.
- **History detail is mostly protected but still needs real-slot browser proof** — APIs return useful summaries/expandable detail, but the selected browser row should be checked after a real Claude switch/run.
- **AI feedback cache shape is in place** — per-incubator latest endpoints return local Ollama/Qwen parsed fields where files exist; Tidebound currently has no saved feedback yet.
