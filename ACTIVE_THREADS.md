# Active Threads

*Updated 2026-10-12 (Run 193 MUTATE). Active project: pi-pulse.*

- **Controller verification unified** - Completion rejects missing checks and failed/incomplete browser evidence. Both core agents share checks, rollback and fresh review while retaining freeform rotation. Full Linux build passed in an isolated Pi copy: 63 trust fixtures, 18 UI checks, API smoke and four verification regressions. Server-aware dashboard visual evidence remains outstanding.

- **Jev removal verified for main** - Runtime hooks, evaluator, dedicated tests/docs, and local skill are removed. Full Linux verification passed. The live Pi checkout has separate uncommitted changes and must be reconciled before updating its deployment. Earlier live-state observations below are historical and need rechecking.

- **Runner authority drift is the next trust bug** — live state shows `incubators.json` can say Claude while `status.json`, preflight, and the active process still run Codex.
- **Fresh service proof is no longer the blocker** — `/api/health.source.changedSinceStart === false`, unknown `/api/*` returns JSON 404, and `npm run test:trust` passes.
- **History detail is mostly protected but still needs real-slot browser proof** — APIs return useful summaries/expandable detail, but the selected browser row should be checked after a real Claude switch/run.
- **AI feedback cache shape is in place** — per-incubator latest endpoints return local Ollama/Qwen parsed fields where files exist; Tidebound currently has no saved feedback yet.
