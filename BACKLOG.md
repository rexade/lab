# Backlog

## ghost/whisper/oracle as incubated project
The quartet (src/ghost/) is dormant — 5 standalone JS files, ports 3032–3036. Per the seed, it must NOT be integrated into Pi Pulse's Pulse tab UI. The correct pattern: create `projects/ghost-trio/status.json` with repo/runLog/runScript fields, point `mounted.json` at it, restart pi-pulse. Then the quartet gets its own ProjectPanel slot and run history without touching the waveform layer. One status.json + one run script = fully mounted. This is the right way to continue the ghost/oracle work without violating the "no new instruments" rule.

## server.js: replace hardcoded 'race-whisperer-predict' fallback strings
`loadMountedProject()` in `server.js` has hardcoded fallback values (`name: 'race-whisperer-predict'`, `dir: '/home/admin/race-whisperer-predict'`, etc.) that fire when `mounted.json` is missing or malformed. The silent-catch was fixed on 2026-07-03 (now logs `console.error`), but the fallback still steers a broken config at race-whisperer. Better fallback: throw and let systemd surface it, OR fall back to a minimal safe stub that clearly identifies as a config-error state. Not urgent — the console.error already makes the failure visible.

Ideas worth revisiting. Add to this over time.

---

## Catmull-Rom waveform upgrade
The current `buildPath` function uses quadratic bezier (C1 continuity). Catmull-Rom gives C2 (curvature-continuous) which is visibly smoother on live CPU data. No new dependency needed — implement directly:
```
B1 = P1 + (P2 - P0) / 6
B2 = P2 - (P3 - P1) / 6
```
Generates SVG `C` commands instead of `Q`. Keep `useMemo` on the path. Drop-in replacement for `buildPath`.

## `@property --accent` for smooth ambient transitions
Using `document.documentElement.style.setProperty('--accent', color)` works but the color snaps hard. Register the property in CSS:
```css
@property --accent {
  syntax: '<color>';
  inherits: true;
  initial-value: #22d3ee;
}
```
Then add `transition: --accent 1.2s ease` to `:root`. Now the entire UI color-shifts smoothly as load rises/falls. Required for ambient color mode to feel premium rather than janky.

## Unified lower panel ("single instrument" layout)
Replace the 2-column card grid (RunHistory + ControlCluster as siblings) with one unified surface containing both as sections. Internal dividers = hairline `border-bottom` with `rgba(255,255,255,0.05)`. Removes the "dashboard of parts" feeling that the current floating cards create. Controls move to a horizontal icon row at the bottom, freeing vertical space for timeline.

## RunHistory as vertical timeline
Replace stacked cards with a vertical timeline: thin 1px left-edge accent line, circular color-coded nodes (cyan=CREATE, purple=MUTATE, green=RESEARCH), run content branching right. 24–32px between nodes. Looks intentional with 2 items; feels like a console event log with 4+. Ghost cards (opacity: 0.15, blur: 2px, pulsing) for the empty state — same card structure so no layout shift when real runs arrive.

## Cold instrument pattern — AI zone idle body
The idle compact mode body (`!loading && !analysis`) shows a text placeholder that has no structural relation to the loaded field rows. Apply the "cold instrument" pattern: render the same 5 FIELD_META rows with `—` values, labels at 50% opacity, same padding + hairline separators — identical DOM structure to the loaded state. Loading state is already this way. Idle should match. The reveal on first load then becomes a pure content swap with no layout shift. One block in `AnalysisBody`, compact branch.

## Offline header tint — AI zone
Three header states (idle / active / offline) currently look identical except the dot color. When `unavailable`, apply a red border-top tint (`rgba(248,113,113,0.15) solid 1px`) instead of `var(--border)` — mirrors how `intelligenceActive` shifts the border to accent. No new chrome, just the same pattern applied to the third state.

## Run status polling
After "Run Lab" is triggered, poll `/api/run/status` every 3s and show a progress indicator ("running…" → "complete"). Currently the feedback disappears after 800ms with no idea if the process finished. Would make the control feel real.

## narrator quality — temperature tuning
Run 63 audit (23 live samples, stale code): ~13% sensory. Garbled outputs ("arenaught", "areading") are tokenization artifacts from qwen2.5-instruct:1.5b — the model sometimes generates "I are..." as broken first-person. These are single-line so `.split('\n')[0]` doesn't catch them. After restart + quality assessment, if garbled rate stays high, consider adding `options: { stop: ['I are', '\n\n'] }` as a secondary stop signal. Primary fix is still temperature: 1.2 after restart confirms base quality.

## Day Ring + Machine Diary temporal linking — DONE (Run 50, 51)
Implemented in Run 50: DayRing hover cross-reference shows closest narration entry by timestamp. Run 51 added clock time label beneath the hover quote. Working. Gets richer as the ring fills to 12h+.
