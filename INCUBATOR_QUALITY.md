# Incubator Quality Contract

> **Scope (2026-09-27):** this self-reported contract now governs the core lab
> loop (`run-lab.sh`, `prompts/*.md`). Incubator slots no longer fill in quality
> fields: the lab runs their checks and keeps or reverts each session, and an
> independent agent reviews what was kept. See `projects/INCUBATOR.md`.

Pi Pulse does not treat agent output as good just because the runner exited cleanly.
Every incubator run must leave enough evidence for the next run and the UI to judge state.

## Principles

- User steering is binding. Convert the latest user feedback into one acceptance check before choosing work.
- A runner success is only process health. Product quality needs a separate quality gate.
- Prefer one verified improvement over broad unchecked changes.
- Keep the trail local and repeatable: files inspected, commands run, screenshots or manual UI checks, and the next action must be visible in the run log.
- If evidence is missing, say `NEEDS-EVIDENCE` instead of claiming success.
- If the app cannot start, the main workflow cannot be checked, or user steering is not addressed, say `FAIL`.

## Negative Feedback Recovery Gate

When the latest user feedback says the app is ugly, confusing, broken, crashed,
not working, insufficient, worse than an existing alternative, or otherwise
below the user's bar, the next run is in recovery mode.

Recovery mode changes the run contract:

- Do not add new features, modes, panels, lore, copy, or systems until the
  complaint is directly addressed.
- Start by identifying the smallest user-visible failure behind the feedback.
- Prefer deleting, simplifying, restyling, or rebuilding the first screen/main
  workflow over adding explanations.
- For UI/app projects, verify the exact complaint path: app opens, first screen
  is understandable, primary action works, and the main workflow changes visible
  state.
- `PASS` is forbidden unless the evidence explicitly shows the complaint path
  is fixed. Otherwise use `NEEDS-EVIDENCE` or `FAIL`.
- The next run-log entry must include `**Recovery mode:** yes` and name the
  complaint it addressed.


## App Runtime Evidence Gate

For static, React, and web app incubators, every run should leave a machine-written
artifact under `reports/evidence/run-[number]/`. The first version of this gate is
degraded-mode browser evidence: launch the app when possible, capture desktop and
mobile screenshots, record console/page errors, and check for blank output.

- `PASS` for a UI/app run requires app evidence `PASS`, or a clear explanation that
  runtime UI evidence is not applicable to the run.
- Missing browser tooling, missing screenshots, or unexercised primary flow means
  `NEEDS-EVIDENCE`, not `PASS`.
- Interactive UI apps must prove at least one visible primary action was exercised
  and produced an observable state change before claiming top-tier quality.
- Blank pages, uncaught page errors, or console errors in the main flow mean `FAIL`
  unless the run explicitly fixed a non-runtime issue and names that limitation.
- First-class future state should follow `ai-runtime-harness` principles: app-owned
  debug surfaces, semantic visibility, named interaction affordances, success
  contracts, and visual proof. Degraded browser evidence is only the baseline.

## Semantic App Contract

Interactive web/static/React apps should register a tiny app-owned debug surface:

```js
window.__PI_PULSE_APP__ = {
  version: 1,
  name: 'app name',
  type: 'web-app',
  primaryAction: {
    selector: '[data-primary-action]',
    label: 'Start',
    expect: { selector: '[data-app-state]', textIncludes: 'started' }
  },
  reset() {},
  snapshot() { return { state: 'idle' } }
}
```

Rules:

- `primaryAction.selector` must point to a visible user path, not a hidden state shortcut.
- `primaryAction.expect` or `success` must be machine-checkable.
- `reset` and `snapshot` are optional, but required for repeatable 4.5+ evidence.
- Without `window.__PI_PULSE_APP__`, browser evidence is degraded and cannot justify a 4.5+ rating.

## Required Work Order

1. Read current steering, recent run history, and only the files needed for this run.
2. State the acceptance check for this run in your own working notes.
3. Implement or investigate one focused change.
4. Verify with the strongest available evidence: command/test output, file inspection, screenshot, browser/manual UI capture, or an explicit reason it is not applicable.
5. Review what got worse or remains risky.
6. Append the quality fields below to the run log.

## Quality Gate

Use exactly one gate in every run-log entry:

- `PASS`: acceptance check met, evidence attached, and no blocking regression found.
- `NEEDS-EVIDENCE`: runner completed but evidence is thin, incomplete, or not independently checkable.
- `FAIL`: acceptance check missed, app/test failed, main workflow is broken, or the run ignored binding user steering.

Ratings are 0 to 5:

- `Quality rating`: state of the generated product or investigation after this run.
- `Evidence confidence`: confidence that the rating is backed by concrete evidence.

## Required Run Log Fields

Every CREATE, MUTATE, RESEARCH, and HARVEST entry must include:

```
**Acceptance check:** [one concrete criterion derived from steering/seed]
**Evidence:** [commands, files, screenshots/manual checks, or explicit not-applicable reason]
**App evidence:** [reports/evidence/run-[number]/summary.md, or not applicable]
**Quality gate:** PASS | NEEDS-EVIDENCE | FAIL
**Quality rating:** [0-5]/5
**Evidence confidence:** [0-5]/5
**Risk / regression:** [what got worse, is unverified, or could break next]
**Next move:** [one small follow-up]
```

For UI/app runs, evidence should include that the app starts and that the main workflow was exercised. If screenshots are unavailable, record the exact manual check instead.
