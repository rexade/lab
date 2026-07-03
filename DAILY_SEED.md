# Daily Seed

**Direction:**
Improve Pi Pulse as the incubator host. The Core incubator should work on the incubator itself: output quality, run bookkeeping, scheduler/runner reliability, per-incubator AI feedback, and the UI that explains what each loop did and will do next.

**Immediate priorities:**
- Show the last saved AI feedback for the selected incubator; do not regenerate merely because the user switches project cards.
- Store AI feedback uniquely per incubator, and label it as local Ollama/Qwen analysis rather than AI HAT+ hardware.
- Fix any API route that falls through to `index.html` and causes `Unexpected token '<'` JSON parse errors.
- Make failed stdout-only runs visible in history as `FAILED` with the actual command error, not `---` or empty summaries.
- Keep child project work secondary unless it directly improves the incubator loop.

*(User directive — 2026-07-03.)*
