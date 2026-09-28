# Incubator shadow acceptance gate

The shadow gate records what an evidence-based acceptance policy would propose.
It cannot commit, revert, pause, reschedule, advance a milestone, or promote a
candidate. The existing checks, keep/revert behavior, and independent review
remain authoritative. There is no enforcement switch or automatic activation
after a session count.

## Enable

Set `"shadowGate": true` in a slot's controller-owned `status.json`, or set
`PI_PULSE_SHADOW_GATE=1` in the runner environment for all slots. It is off by
default; `PI_PULSE_SHADOW_GATE=0` overrides slot settings.

Provide `TYPESAFE_API_KEY` to the controller process. The runner does not source
project `.env` files or copy credentials into bundles. For local replay with
Node 22, run from the lab root:

```sh
node --env-file=.env src/pi-pulse/scripts/shadow-gate.mjs evaluate <bundle-directory>
node src/pi-pulse/scripts/shadow-gate.mjs report <slot-directory>/shadow
node src/pi-pulse/scripts/shadow-gate.mjs label <bundle-directory> <human-review.json>
```

The key in this checkout is local; installation does not configure the Pi's
service environment. Automatic evaluation pins `jev-1.13.0`; `TYPESAFE_MODEL`
can select a different model. Every response records its actual model version.
A request has a 20-second timeout. Missing keys, HTTP failures, malformed
responses, and oversized requests produce unavailable/UNKNOWN observations.
They never change the actual incubator outcome.

## Evidence contract

Bundles live beside the slot's `status.json`, outside the builder workspace:

```text
shadow/session-<run>-<uuid>/
  goal.json
  acceptance-criteria.json
  steering.md
  before/
    product.json
    checks.json
    metrics.json
    runtime.log
    reviewer.json
    screenshots/*.png
  after/
    product.json
    checks.json
    metrics.json
    runtime.log
    screenshots/*.png
  candidate.json
  diff.patch
  reviewer.json
  actual-incubator-outcome.json
  baseline-manifest.json
  candidate-manifest.json
  manifest.json
  evaluations/<timestamp>-<uuid>/
    request.json
    response.json                 # only a valid response
    jev-judgments.json
    hard-checks.json
    policy-decision.json
    shadow-report.json
    manifest.json
  human-reviews/<uuid>.json
```

The controller captures starting criteria before the builder runs and candidate
evidence before keep/revert. The diff includes untracked product files, using a
temporary Git index without modifying the real index. Reports and credential
files are excluded. Known credential patterns are redacted; redacted patches or
changes to excluded tracked credential files mark the diff incomplete.
Runtime logs contain browser console events and page errors, not builder transcripts.

Files are written once. SHA-256 manifests seal the baseline, candidate, final
bundle, and each evaluation. Verification rejects changed or missing evidence
before an API call or decision. These are tamper-detecting local records, not
signed archives or filesystem-enforced immutability. Replays create new
evaluation directories and never overwrite the original evaluation.

The current builder chooses its bounded session goal during the run. The frozen
target is therefore explicitly the milestone at session start. A retrospective
builder goal is saved only as a claim, never substituted for that target.
Shaping sessions without pre-existing criteria propose ESCALATE. A future
pre-build session-goal handshake can extend this schema without changing policy
authority. Milestone completion is separate from useful partial progress.

The existing runner reviews kept/no-change sessions only. Rejected and failed
candidates still retain their diff and observations, but have an explicitly
unavailable reviewer. The shadow gate does not run an additional builder or
reviewer. UI review prompts include immutable before/after screenshots and ask
for concrete visual observations. Missing inspection is not a clean UI bill.

## Evaluator and policy

`evaluator.mjs` turns text evidence into Choice judgments: goal progress,
behavior regression, UX regression, scope drift, quality delta, and evidence
sufficiency. All allow UNKNOWN. It never asks for an acceptance action.
`gate.mjs` accepts an evaluator function with the same result contract, so another
evaluator can replace Jev without changing capture or policy.

Each judgment saves its distribution, confidence, and evidence references.
`evidenceBasis: supplied-context` explicitly means the referenced artifacts were
provided for that question. These are provenance, not model-generated citations
or proof of which inputs caused an answer. `request.json` preserves the complete
text request. Jev cannot inspect images; visual judgments rely on the independent
reviewer's recorded observations. The actual incubator outcome is withheld from
the evaluator to avoid leaking the answer being compared.

Input excerpts are bounded and truncation is explicit. The request budget is
28,000 UTF-8 bytes. Missing goals, checks, review, UI comparisons, or candidate
coverage prevent an ACCEPT proposal even if Jev is confident.

The independent, versioned `policy.mjs` applies these rules in order:

1. A previously passing comparable check now fails, the app becomes blank, or
   runtime errors increase: REJECT, regardless of evaluator availability.
2. Missing evidence or uncertain required judgments: ESCALATE.
3. Evidence sufficiency is not YES: ESCALATE.
4. Behavior regression is YES, or goal progress is NONE: REJECT.
5. UX regression, worse quality, or material scope drift: REWORK.
6. Otherwise, useful partial or greater progress: ACCEPT.

The initial confidence threshold is 0.8, marked `calibrated: false`. Confidence
is not the probability of correctness. REWORK means preserving an unpromoted
candidate; ESCALATE means holding it for another decision. In shadow mode these
are recorded proposals only: candidate branches, worktrees, and enforcement
transitions are deliberately not implemented.

## Compare and label

A human review file has this shape (include only judgments actually assessed):

```json
{
  "reviewer": "Henrik",
  "action": "ACCEPT",
  "judgments": {
    "goalProgress": "PARTIAL",
    "behaviorRegression": "NO",
    "qualityDelta": "BETTER"
  },
  "notes": "The export works; imports remain for another session."
}
```

The label command appends a timestamped annotation linked to the bundle hash.
The report compares actual outcome, independent review, first shadow proposal,
and latest human label. Replays do not increase the real-session count. It shows
UNKNOWN counts, evidence gaps, confidence bins with labeled/correct counts, and
accuracy counts for NO REGRESSION above 0.90 confidence. It never treats the
incubator decision or reviewer verdict as human ground truth. No-change and
failed runs retain their raw outcomes and are not forced into ACCEPT/REJECT.

Collect 50-100 real sessions and inspect disagreements before considering
enforcement. Sample count alone does not establish reliability. Preserve model,
question, schema, and policy versions when comparing evaluations.

Verification: `npm run test:shadow` exercises capture, actual rollback survival,
policy precedence, partial progress, UNKNOWN handling, API failures, immutable
replays, explicit human labeling, and isolation from live lifecycle decisions.
It is also included in `npm run test:trust` and `npm run build`.

TypeSafe references: [HTTP API](https://docs.typesafe.ai/api),
[Choice](https://docs.typesafe.ai/primitives/choice),
[state and text-only input](https://docs.typesafe.ai/concepts/state), and
[confidence](https://docs.typesafe.ai/confidence).
