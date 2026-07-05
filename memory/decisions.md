# Pi Pulse — Durable Decisions

## Instruments (frozen)
- Three instruments only: CPU waveform / temp sparkline / Net Pulse / DayRing — **stop here**
- No new panels, widgets, or data channels without a seed change
- Waveform is the soul — never remove or replace PulsePanel CPU waveform

## Aesthetic
- Background #080808 — never lighter than #0d0d0d
- Accent color shifts cyan → orange → red as CPU load rises (CSS @property --accent)
- Premium dark, device-console aesthetic — not a generic dashboard grid
- Catmull-Rom curves for all waveforms (C2-continuous); quadratic bezier is deprecated

## Architecture
- SSE (not WebSocket or polling) for live stats push — 2s interval, paused when no clients
- SSE sends one `buildStatsPayload()` result per tick via `lastStatsPayload`.
- `pushDaySnapshot()` must call `buildStatsPayload()` fresh so the 24h graph keeps recording while the dashboard is closed.
- `getNetworkRate()` is stateful (byte-delta), so it returns the cached rate for sub-second duplicate calls.
- Only edit /home/admin/lab/src/ — no other directories
- Never deploy if `npm run build` fails or throws warnings

## Process
- Seed overrides agent instinct — if seed says don't add X, don't add X
- One meaningful change per run beats ten small tweaks
- Never touch race-whisperer-predict source from the pi-pulse run loop
