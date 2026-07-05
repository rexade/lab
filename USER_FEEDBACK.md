# User Feedback / Steering Notes

These notes are written from the Pi Pulse UI and injected into future host incubator runs.

## 2026-07-03T21:02:57.267Z

Priority 1 - Make failed runs impossible to miss.

This is the most important thing. If an autonomous loop fails silently, the whole system becomes fake and the user loses trust.

Fix and preserve these guarantees:
- failed stdout-only runs show as FAILED
- real command error is visible
- preflight blocks bad runs before launch
- history row expands with useful failure detail

This is boring but foundational.

Priority 2 - Per-incubator AI feedback.

AI feedback should be cached per project/incubator. Switching project cards should not regenerate analysis. That would feel random and expensive.

Correct behavior:
- each incubator has last saved feedback
- refresh only happens when the user explicitly asks or after a completed run
- label source clearly as local Ollama/Qwen
- feedback object includes parsed fields: DIRECTION, STRONGEST, WEAKEST, DRIFT, NEXT

This turns the UI from chatty toy into instrument panel.

Priority 3 - Fix API/SPA fallthrough.

Any /api/* route returning index.html is a trust killer. Fully kill Unexpected token '<' cases:
- unknown /api/* returns JSON 404
- project play routes should not pretend to exist unless static serving is actually registered
- if runtime-created incubator slots need restart, actually restart or dynamically mount the route

Product boundary rule:
Pi Pulse should not absorb child projects into itself. Do not put ghost, race-whisperer, taste-trainer, etc. into the main dashboard as custom feature tabs.

Every child project should have:
- projects/<name>/status.json
- run-<name>.sh
- RUN_LOG.md
- optional playUrl

Then Pi Pulse hosts it as an incubator slot. That keeps the host clean.

README framing to keep near top:
# pi-lab

A Raspberry Pi-hosted creative incubator for autonomous AI work.

Pi Lab runs repeated create/mutate/research loops against mounted projects. It keeps memory, taste feedback, run history, failure visibility, and human steering in one small local system.

This is not a generic dashboard. It is a workshop for producing weird, shippable creative software.

Blunt advice:
Do not steer this repo toward more features. Steer it toward higher trust per run.

A good next version is one where opening Pi Pulse instantly answers:
- what ran
- whether it succeeded
- what changed
- why it failed
- what the next run will try
- what feedback the local critic gave
- whether the incubator is drifting

## 2026-07-04T11:32:49.285Z

The last Incubator i added cannot run in Claude fable. I cannot switch the relay. And it also does not give any output in run history more than a message about stdout

## 2026-07-04T11:41:47.892Z

I want to make sure the new invubators i have added works

## 2026-07-04T11:55:53.707Z

stdout captured with no summary

## 2026-07-04T13:01:18.597Z

Still not able to switch to Claude for my newly created Incubator. And i cant see run history properly
