# Persistent products

Incubators default to `lifecycle: product`. A product has a lasting mission and successive milestones. Sessions are bounded implementation increments; milestones may span many sessions. There is no product-size or session-count completion rule.

- `BRIEF.md`: purpose, audience, constraints, important decisions/lessons, revisable opportunities.
- `MILESTONE.md`: current goal and `## Done means` checklist. A legacy brief checklist is used until separated.
- Shaping/building/polishing apply to the current milestone. `done` records reviewed milestone completion, not retirement.
- The next scheduled session enters `advancing` (`DEVELOP`), selects the next worthwhile milestone and starts implementation. Repeating the completed checklist does not create progress.
- `lifecycle: explore` uses the same continuation rules but allows a creative lab to deepen or branch into a new experiment while preserving prior playable work.
- Only explicit `lifecycle: finite` rests after completion. An owner-disabled slot stays disabled.

The controller records completed goal/outcome snapshots, count and recent history in status.json. Checkbox changes do not change milestone identity. It supplies recent completions and decisions to fresh sessions. This supports continuity without an expanding procedural manual.

Completion requires a successful, well-formed independent review, milestone outcomes met, no actionable blockers and no known failing checks. Reviewer failures and missing milestone definitions cannot finish work. No-change sessions get fresh checks/review and back off if still unresolved. Checks and reviews remain fallible; none of this proves real-world adoption or subjective quality.

One global writer, sandbox permissions, configured models, timeouts and owner controls remain unchanged. Due-time ordering prevents registry-order starvation. Healthy products retain their existing cadence; failed/no-progress attempts back off and revisit automatically rather than requiring owner approval.

Codex builders and reviewers explicitly use `high` reasoning by default, independently of the operator's personal CLI configuration. `codexReasoningEffort` in a project's status overrides the service default `PI_PULSE_CODEX_REASONING_EFFORT`. Use `xhigh` for a demonstrated benefit on harder work, not as an unmeasured requirement for every bounded session. This follows [official effort guidance](https://developers.openai.com/api/docs/guides/reasoning#reasoning-effort); it is a starting choice, not a measured quality guarantee.

Browser previews show fresh desktop and phone opening states; after-action screenshots are separate. Unobserved rendering remains unknown. A failed click or unavailable browser is not proof of a blank app and cannot cause a rollback by itself, nor can an incomplete inspection certify completion. Actual blank rendering, new runtime errors and failing checks still protect the last good version. Blank means a person would see nothing: when a page has almost no text or elements (a full-screen canvas game), the screenshot's pixels decide (`scripts/lib/pixels.mjs`).

Newly created projects get their own Git repository, even under a parent checkout, so session commits and rollback do not operate on the parent or become disabled. Imported/existing folders are not automatically reinitialized.

Local iteration history is not GitHub promotion. Each experiment may keep a private local repository without publishing anything; only products the owner selects for promotion get a remote. The Pi Pulse repository contains the platform, not the generated app sources. Git on the Pi is not an off-device backup.

Sessions record baseline/candidate commit IDs in `RUN_LOG.md`. Run history exposes a read-only **Compare changes** view with the source diff and available before/after browser captures. Old kept commits remain comparable using their actual parent; missing historical versions are explicitly unavailable. A baseline created later does not reconstruct earlier iterations.

Rejected/failed candidates get a source snapshot under `refs/pi-pulse/candidates/run-N` before rollback. Snapshotting uses a temporary Git index, does not move HEAD, and retains new candidate files for inspection. Reports, browser artifacts, dependencies and common credential files are omitted from source comparisons. No automatic push or remote creation occurs. Backup tooling must include all refs if rejected candidates are to be retained off-device.

Prompt design keeps explicit initiative, constraints and useful product memory. It is informed by [OpenAI's Astra prompt guidance](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra), not a claim that any workflow is universally optimal.

Verification: `npm run build` runs real-runner fixtures with fake agents and temporary Git repos, UI contracts, live HTTP/auth smoke tests, then Vite. Fixtures cover multi-session milestones, second milestones, restart persistence, repeated-goal protection, failed reviews, no-change completion, finite vs ongoing scheduling and fair due ordering.
