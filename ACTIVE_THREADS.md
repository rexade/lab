# Active Threads

*Updated 2026-04-26 (Run 87 RESEARCH). Active project: race-whisperer-predict.*

---

## race-whisperer-predict — current state

- **C1 (trivial mutate):** `noDriverStats` FlagChip missing from `ConfidenceFlagStrip` in `CompactHorseRow.tsx`. Flag is computed, affects reliability score, invisible to user without hovering the dot. Add one `FlagChip` block after the `staleForm` chip (~line 86). No logic or test changes needed.

- **C2 (medium mutate):** `enhancedAtgApi.ts` has **45** raw `console.*` calls — emoji-heavy sulky/driver/earnings debug logs firing unconditionally on every race load. Same cleanup pattern as Runs 10–21/54. Add `import { log } from '@/lib/logger'`, swap all to `log.debug`/`log.warn`, strip emoji prefixes.

- **Bundle C1+C2 into one MUTATE run** — closes the confidence flags story and eliminates the last major console pollution source in one pass.

- **After C1+C2:** Next candidate is corpus expansion (new May 2026 V85 dates via `eval-mae.mjs`) or V4 weight design (try postPosition 0.7→0.5, or consistency 0.5→0.7).

- **Pi Pulse USER ACTIONS still pending:** ghost-trio.service install + pi-pulse restart (see Run 86 output). DayRing ghost-tint layer is deployed but dormant without diary data.
